import "server-only";
import { and, count, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db, withUserLock, type Queryable } from "@/db";
import {
  agentKnowledge,
  agents,
  knowledgeSources,
  ledgerEntries,
  type Agent,
  type AgentKnowledge,
  type KnowledgeMode,
  type KnowledgeSource,
} from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { toMegabytes } from "@/lib/format";
import { failureColumns, stored, type StoredText } from "@/lib/stored-text";
import { agentFingerprint, DELETED_SOURCE, desiredKnowledge, resyncAgentIfStale, syncAgentQuietly } from "./agents";
import { chargePurchase, refundPurchase, type Purchase } from "./billing/ledger";
import { voiceProvider } from "./telnyx";
import type { StoredObject } from "./telnyx/types";

/**
 * Per-agent knowledge bases (SPEC §18): one provider storage bucket per agent that the assistant
 * searches during calls. Sources are paid once, never edited, and deleted permanently.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A source still processing after this never got to the provider (e.g. the server stopped mid-add)
 * or never shows up in its status list; it is failed and refunded rather than polled forever.
 */
const STUCK_MS = 60 * 60 * 1000;

/** Objects we write live under this prefix; anything else in a bucket is a crawled page. */
const OWN_PREFIX = "src/";

export function knowledgeBucketName(agentId: string): string {
  return `ev-kb-${agentId.replace(/-/g, "")}`;
}

function objectKey(sourceId: string, ext: "txt" | "pdf"): string {
  return `${OWN_PREFIX}${sourceId}.${ext}`;
}

/** Both possible keys for a text/file source; deleting is idempotent, so we needn't store which. */
const objectKeys = (sourceId: string) => [objectKey(sourceId, "txt"), objectKey(sourceId, "pdf")];

const isCrawledPage = (key: string) => !key.startsWith(OWN_PREFIX);

async function crawledPages(bucket: string): Promise<StoredObject[]> {
  return (await voiceProvider().listObjects(bucket)).filter((o) => isCrawledPage(o.key));
}

/**
 * Whether a crawl has gone quiet: nothing written since its submission or its newest page for the
 * quiet period. Telnyx reports a crawl finished as soon as it starts and never says when it ends
 * (docs/telnyx-api-notes.md §17), so this is the only sign a crawl is done.
 */
function crawlIsQuiet(s: Pick<KnowledgeSource, "createdAt">, pages: StoredObject[]): boolean {
  const lastWrite = Math.max(s.createdAt.getTime(), ...pages.map((p) => p.modifiedAt.getTime()));
  return Date.now() - lastWrite >= config.limits.knowledgeCrawlQuietMs;
}

type SourceType = KnowledgeSource["type"];

/** Ledger lines name the source type and agent only: nothing from the source stays after it is deleted. */
const LEDGER = {
  text: { charge: "ledgerKnowledgeText", refund: "ledgerKnowledgeTextRefund" },
  file: { charge: "ledgerKnowledgeFile", refund: "ledgerKnowledgeFileRefund" },
  url: { charge: "ledgerKnowledgeUrl", refund: "ledgerKnowledgeUrlRefund" },
} as const;

function purchase(s: Pick<KnowledgeSource, "id" | "userId" | "type" | "priceCents">, agentName: string): Purchase {
  return {
    userId: s.userId,
    priceCents: s.priceCents,
    kind: "knowledge_source",
    key: `knowledge:${s.id}`,
    description: stored(LEDGER[s.type].charge, { agent: agentName }),
    refType: "knowledge_source",
    refId: s.id,
  };
}

export interface AgentKnowledgeView {
  base: AgentKnowledge | null;
  /** Sources to list: deleted ones are gone as far as the user is concerned. */
  sources: KnowledgeSource[];
  /**
   * The agent's website source: listed, or deleted but still being removed (its crawl may still be
   * writing), which holds back the knowledge base and another website until it's gone.
   */
  website: "listed" | "removing" | null;
  /** The agent should search its knowledge base but the provider doesn't have that yet. */
  notApplied: boolean;
  /** The provider still has the knowledge base on the agent although it shouldn't (mode off, or a deletion). */
  notRemoved: boolean;
}

export async function getAgentKnowledge(agent: Agent): Promise<AgentKnowledgeView> {
  const [base] = await db.select().from(agentKnowledge).where(eq(agentKnowledge.agentId, agent.id));
  const all = await db.select().from(knowledgeSources).where(eq(knowledgeSources.agentId, agent.id)).orderBy(knowledgeSources.createdAt);
  const sources = all.filter((s) => s.status !== "deleting");
  const website = sources.some((s) => s.type === "url") ? "listed" : all.some((s) => s.type === "url") ? "removing" : null;
  const desired = (await desiredKnowledge([agent.id])).get(agent.id);
  const stale = agent.status === "ready" && agent.syncedConfig !== agentFingerprint(desired);
  return {
    base: base ?? null,
    sources,
    website,
    notApplied: stale && Boolean(desired),
    // A fingerprint with a knowledge part means the last push included the retrieval tool.
    notRemoved: stale && !desired && Boolean(agent.syncedConfig?.includes(":")),
  };
}

/** Check limits, record the source and charge for it, all under the user's lock (like a voice clone). */
async function reserve(
  userId: string,
  agentId: string,
  type: SourceType,
  fields: Pick<KnowledgeSource, "name" | "content" | "url" | "sizeBytes">,
): Promise<{ source: KnowledgeSource; base: AgentKnowledge; agentName: string }> {
  requireFeature();
  return withUserLock(userId, async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId), isNull(agents.deletedAt)));
    if (!agent) throw new UserError("agentNotFound");

    if ((await countUserSources(userId, tx)) >= config.limits.knowledgeSources) throw new UserError("knowledgeLimit", { max: config.limits.knowledgeSources });

    // Counted from the ledger, which keeps every add even after the source is deleted.
    const [{ adds }] = await tx
      .select({ adds: count() })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.userId, userId),
          eq(ledgerEntries.kind, "knowledge_source"),
          gt(ledgerEntries.createdAt, new Date(Date.now() - DAY_MS)),
        ),
      );
    if (adds >= config.limits.knowledgeAddsPerDay) throw new UserError("knowledgeDailyLimit", { max: config.limits.knowledgeAddsPerDay });

    if (type === "url") {
      // One crawl per bucket: its pages are told apart only by not being ours. A deleted URL source
      // keeps its row until its crawl has finished and its pages are gone.
      const [existing] = await tx
        .select({ status: knowledgeSources.status })
        .from(knowledgeSources)
        .where(and(eq(knowledgeSources.agentId, agentId), eq(knowledgeSources.type, "url")));
      if (existing) throw new UserError(existing.status === "deleting" ? "knowledgeUrlStillRemoving" : "knowledgeOneUrl");
    }

    let [base] = await tx.select().from(agentKnowledge).where(eq(agentKnowledge.agentId, agentId));
    if (!base) {
      [base] = await tx.insert(agentKnowledge).values({ agentId, userId, bucket: knowledgeBucketName(agentId) }).returning();
    }
    if (base.status === "deleting") throw new UserError("agentNotFound");

    const [source] = await tx
      .insert(knowledgeSources)
      .values({ userId, agentId, type, ...fields, priceCents: config.pricing.knowledgeSourceCents })
      .returning();
    await chargePurchase(
      purchase(source, agent.name),
      new UserError("knowledgeInsufficientBalance", { price: config.pricing.knowledgeSourceCents / 100 }),
      tx,
    );
    return { source, base, agentName: agent.name };
  });
}

/**
 * Settle a processing source as failed, at most once. Only the caller whose update wins refunds, so
 * a page poll and the daily job can't both settle it, and a source deleted meanwhile is never refunded.
 * Given the bucket, a text or file source's object is removed too: the provider may still embed it
 * later, and a failed, refunded source must not be searchable.
 */
async function failSource(
  s: KnowledgeSource,
  agentName: string,
  reason: StoredText,
  opts: { refund?: boolean; bucket?: string } = {},
): Promise<void> {
  // One transaction, so a failed removal or refund leaves the source processing and it is settled again later.
  await db.transaction(async (tx) => {
    const [u] = await tx
      .update(knowledgeSources)
      .set({ status: "failed", ...failureColumns(reason) })
      .where(and(eq(knowledgeSources.id, s.id), eq(knowledgeSources.status, "processing")))
      .returning();
    if (!u) return;
    if (opts.bucket && s.type !== "url") {
      for (const key of objectKeys(s.id)) await voiceProvider().deleteObject(opts.bucket, key);
    }
    if (opts.refund ?? true) {
      await refundPurchase(purchase(s, agentName), stored(LEDGER[s.type].refund, { agent: agentName }), tx);
    }
  });
}

async function markReady(s: KnowledgeSource, sizeBytes?: number): Promise<void> {
  await db
    .update(knowledgeSources)
    .set({ status: "ready", ...(sizeBytes === undefined ? {} : { sizeBytes }) })
    .where(and(eq(knowledgeSources.id, s.id), eq(knowledgeSources.status, "processing")));
}

function isBucketLimit(err: unknown): boolean {
  return err instanceof Error && /TooManyBuckets/.test(`${(err as { code?: string }).code ?? ""} ${err.message}`);
}

/** Create the bucket and turn embedding on, once. Returns whether embedding was just turned on. */
async function ensureBucket(base: AgentKnowledge): Promise<boolean> {
  if (base.embeddedAt) return false;
  const provider = voiceProvider();
  await provider.createBucket(base.bucket);
  await provider.enableEmbedding(base.bucket);
  await db.update(agentKnowledge).set({ embeddedAt: new Date() }).where(eq(agentKnowledge.agentId, base.agentId));
  return true;
}

/** The provider side of adding a source, outside the user lock. Failures are refunded. */
async function upload(
  reserved: { source: KnowledgeSource; base: AgentKnowledge; agentName: string },
  write: (bucket: string) => Promise<Partial<KnowledgeSource> | void>,
): Promise<KnowledgeSource> {
  const { source, base, agentName } = reserved;
  let written = false;
  try {
    const embeddingTurnedOn = await ensureBucket(base);
    const patch = await write(base.bucket);
    written = true;
    if (patch) await db.update(knowledgeSources).set(patch).where(eq(knowledgeSources.id, source.id));
    // The agent can search its bucket from now on.
    if (embeddingTurnedOn) await resyncAgentIfStale(source.agentId);
  } catch (err) {
    console.error("knowledge upload failed", source.id, err);
    // Only remove what was written: a write that failed left nothing, and the provider may be down.
    await failSource(source, agentName, isBucketLimit(err) ? stored("knowledgeBucketsFull") : stored("knowledgeUploadFailed"), {
      bucket: written ? base.bucket : undefined,
    });
  }
  // Deleted while uploading: remove what was just written.
  await cleanUpKnowledge({ agentId: source.agentId });
  const [fresh] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.id));
  if (!fresh) await removeLateWrite(source, base.bucket);
  return fresh ?? source;
}

/**
 * The source (or its agent) was deleted and cleaned up while it uploaded, so that cleanup ran before
 * this write landed and its rows are gone: nothing else would remove what was written. Website
 * sources can't get here, since their row is kept while a crawl is being submitted.
 */
async function removeLateWrite(s: KnowledgeSource, bucket: string): Promise<void> {
  const provider = voiceProvider();
  try {
    const [base] = await db.select({ agentId: agentKnowledge.agentId }).from(agentKnowledge).where(eq(agentKnowledge.agentId, s.agentId));
    if (base) {
      for (const key of objectKeys(s.id)) await provider.deleteObject(bucket, key);
    } else {
      // The agent's knowledge base was torn down before ensureBucket() created the bucket again.
      for (const o of await provider.listObjects(bucket)) await provider.deleteObject(bucket, o.key);
      await provider.deleteBucket(bucket);
    }
  } catch (err) {
    console.error("knowledge late write cleanup failed", s.id, err);
  }
}

export async function addTextSource(userId: string, agentId: string, raw: { title: unknown; text: unknown }): Promise<KnowledgeSource> {
  const title = String(raw.title ?? "").trim();
  // Forms send line breaks as CRLF, which the textarea's maxLength counts as one character.
  const text = String(raw.text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!title || title.length > 80) throw new UserError("knowledgeTitleRequired");
  if (!text) throw new UserError("knowledgeTextRequired");
  if (text.length > config.limits.knowledgeTextChars) throw new UserError("knowledgeTextTooLong", { max: config.limits.knowledgeTextChars });
  const body = new Blob([text], { type: "text/plain" });
  const reserved = await reserve(userId, agentId, "text", { name: title, content: text, url: null, sizeBytes: body.size });
  return upload(reserved, (bucket) => voiceProvider().putObject(bucket, objectKey(reserved.source.id, "txt"), body, "text/plain"));
}

export async function addFileSource(userId: string, agentId: string, file: File | null): Promise<KnowledgeSource> {
  if (!file || file.size === 0) throw new UserError("knowledgeFileEmpty");
  const ext = file.name.split(".").pop()?.toLowerCase();
  let body: Blob;
  let key: "txt" | "pdf";
  if (ext === "txt" || ext === "md") {
    // Markdown is plain text to the embedder; store both as .txt.
    const text = await file.text();
    if (!text.trim()) throw new UserError("knowledgeFileEmpty");
    if (text.length > config.limits.knowledgeFileChars) throw new UserError("knowledgeFileTooLong", { max: config.limits.knowledgeFileChars });
    body = new Blob([text], { type: "text/plain" });
    key = "txt";
  } else if (ext === "pdf") {
    if (file.size > config.limits.knowledgePdfBytes) throw new UserError("knowledgeFileTooLarge", { size: toMegabytes(config.limits.knowledgePdfBytes) });
    const head = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
    if (head !== "%PDF-") throw new UserError("knowledgeFileType");
    body = file;
    key = "pdf";
  } else {
    throw new UserError("knowledgeFileType");
  }
  const reserved = await reserve(userId, agentId, "file", { name: file.name.slice(0, 200), content: null, url: null, sizeBytes: body.size });
  return upload(reserved, (bucket) =>
    voiceProvider().putObject(bucket, objectKey(reserved.source.id, key), body, key === "pdf" ? "application/pdf" : "text/plain"),
  );
}

export async function addUrlSource(userId: string, agentId: string, raw: unknown): Promise<KnowledgeSource> {
  if (!config.features.knowledgeUrls) throw new UserError("notAvailable");
  const value = String(raw ?? "").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError("knowledgeUrlInvalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || value.length > 2000) throw new UserError("knowledgeUrlInvalid");
  const reserved = await reserve(userId, agentId, "url", { name: url.href, content: null, url: url.href, sizeBytes: null });
  return upload(reserved, async (bucket) => ({ crawlTaskId: (await voiceProvider().crawlUrl(bucket, url.href)).taskId }));
}

/** Permanently delete a source: what we hold is cleared now, the provider copy right after (or by retries). */
export async function deleteSource(userId: string, sourceId: string): Promise<void> {
  requireFeature();
  const [s] = await db
    .update(knowledgeSources)
    .set(DELETED_SOURCE)
    .where(and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.userId, userId), ne(knowledgeSources.status, "deleting")))
    .returning();
  if (!s) throw new UserError("knowledgeSourceNotFound");
  await cleanUpKnowledge({ agentId: s.agentId });
  // Usually a no-op. While provider cleanup is still pending this drops the retrieval tool so the
  // deleted content can't be quoted, and it restores the tool once cleanup is done.
  await resyncAgentIfStale(s.agentId);
}

/**
 * Save how the agent uses its knowledge base. Returns whether the agent has the change now; if not,
 * it keeps its previous setup until a retry (page visits and the daily job) gets through.
 */
export async function setKnowledgeMode(userId: string, agentId: string, mode: unknown): Promise<boolean> {
  requireFeature();
  if (mode !== "off" && mode !== "reference" && mode !== "strict") throw new UserError("invalidInput");
  const [base] = await db
    .update(agentKnowledge)
    .set({ mode: mode satisfies KnowledgeMode })
    .where(and(eq(agentKnowledge.agentId, agentId), eq(agentKnowledge.userId, userId), eq(agentKnowledge.status, "ready")))
    .returning();
  if (!base) throw new UserError("knowledgeNotFound");
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  // An agent that isn't ready gets the mode with its next save.
  return agent?.status === "ready" ? syncAgentQuietly(agent) : true;
}

function requireFeature() {
  if (!config.features.knowledgeBase) throw new UserError("notAvailable");
}

/** Limit work to one agent's knowledge base; everything when absent. */
type Scope = { agentId?: string };

const scoped = (scope: Scope) => (scope.agentId ? eq(knowledgeSources.agentId, scope.agentId) : undefined);

const isStuck = (s: KnowledgeSource) => Date.now() - s.createdAt.getTime() > STUCK_MS;

/**
 * Whether a website source's crawl may still write pages into the bucket: it hasn't gone quiet, or
 * it is being submitted (no task id yet, and recent enough that the submission may still succeed).
 */
async function crawlMayWrite(s: Pick<KnowledgeSource, "type" | "crawlTaskId" | "createdAt">, bucket: string): Promise<boolean> {
  if (s.type !== "url") return false;
  if (!s.crawlTaskId) return Date.now() - s.createdAt.getTime() < STUCK_MS;
  return !crawlIsQuiet(s, await crawledPages(bucket));
}

/** Settle processing sources from the provider's embedding and crawl status. */
export async function refreshKnowledge(scope: Scope = {}): Promise<void> {
  const rows = await db
    .select({ source: knowledgeSources, bucket: agentKnowledge.bucket, agentName: agents.name })
    .from(knowledgeSources)
    .innerJoin(agentKnowledge, eq(agentKnowledge.agentId, knowledgeSources.agentId))
    .innerJoin(agents, eq(agents.id, knowledgeSources.agentId))
    .where(and(eq(knowledgeSources.status, "processing"), scoped(scope)));
  const provider = voiceProvider();
  const statuses = new Map<string, Awaited<ReturnType<typeof provider.embeddingStatuses>>>();
  for (const { source: s, bucket, agentName } of rows) {
    try {
      if (s.type === "url") {
        await settleCrawl(s, bucket, agentName);
        continue;
      }
      if (!statuses.has(bucket)) statuses.set(bucket, await provider.embeddingStatuses(bucket));
      const st = objectKeys(s.id).map((k) => statuses.get(bucket)!.get(k)).find(Boolean);
      if (st === "ready") await markReady(s);
      else if (st === "failed") await failSource(s, agentName, stored("knowledgeUnreadable"), { bucket });
      else if (isStuck(s)) await failSource(s, agentName, stored("knowledgeUploadFailed"), { bucket });
    } catch (err) {
      console.error("refreshKnowledge failed", s.id, err);
    }
  }
  await cleanUpKnowledge(scope);
}

async function settleCrawl(s: KnowledgeSource, bucket: string, agentName: string): Promise<void> {
  if (!s.crawlTaskId) {
    // Still being submitted, or the submission was lost.
    if (isStuck(s)) await failSource(s, agentName, stored("knowledgeUploadFailed"));
    return;
  }
  const pages = await crawledPages(bucket);
  // A crawl can't be limited or cancelled, so its size is checked once it has gone quiet.
  if (!crawlIsQuiet(s, pages)) return;
  const bytes = pages.reduce((sum, p) => sum + p.sizeBytes, 0);
  if (pages.length === 0) {
    await failSource(s, agentName, stored("knowledgeUrlUnreadable"));
  } else if (bytes > config.limits.knowledgeCrawlBytes) {
    const provider = voiceProvider();
    for (const p of pages) await provider.deleteObject(bucket, p.key);
    // Not refunded: the provider already charged for embedding these pages.
    await failSource(s, agentName, stored("knowledgeSiteTooLarge"), { refund: false });
  } else {
    await markReady(s, bytes);
  }
}

/**
 * Remove the provider copy of deleted sources and of deleted agents' knowledge bases, then drop
 * their rows. Anything that fails is left for the next run (page visits and the daily job).
 */
export async function cleanUpKnowledge(scope: Scope = {}): Promise<void> {
  const provider = voiceProvider();

  // A build from before knowledge bases (previews share the database) deletes an agent without
  // marking its knowledge base; do here what deleteAgent() does now.
  const deletedAgents = db.select({ id: agents.id }).from(agents).where(isNotNull(agents.deletedAt));
  await db.transaction(async (tx) => {
    await tx
      .update(knowledgeSources)
      .set(DELETED_SOURCE)
      .where(and(inArray(knowledgeSources.agentId, deletedAgents), ne(knowledgeSources.status, "deleting"), scoped(scope)));
    await tx
      .update(agentKnowledge)
      .set({ status: "deleting" })
      .where(
        and(
          inArray(agentKnowledge.agentId, deletedAgents),
          eq(agentKnowledge.status, "ready"),
          scope.agentId ? eq(agentKnowledge.agentId, scope.agentId) : undefined,
        ),
      );
  });

  const bases = await db
    .select()
    .from(agentKnowledge)
    .where(
      and(
        eq(agentKnowledge.status, "deleting"),
        scope.agentId ? eq(agentKnowledge.agentId, scope.agentId) : undefined,
      ),
    );
  const tornDown = new Set<string>();
  for (const base of bases) {
    try {
      const crawls = await db
        .select()
        .from(knowledgeSources)
        .where(and(eq(knowledgeSources.agentId, base.agentId), eq(knowledgeSources.type, "url")));
      // A running crawl would keep writing pages into the bucket; wait for it to finish.
      if (await someAsync(crawls, (c) => crawlMayWrite(c, base.bucket))) continue;
      // Always, even if embedding was never recorded: the bucket may exist anyway. Both steps
      // succeed when there is nothing to delete.
      for (const o of await provider.listObjects(base.bucket)) await provider.deleteObject(base.bucket, o.key);
      await provider.deleteBucket(base.bucket);
      await db.transaction(async (tx) => {
        await tx.delete(knowledgeSources).where(eq(knowledgeSources.agentId, base.agentId));
        await tx.delete(agentKnowledge).where(eq(agentKnowledge.agentId, base.agentId));
      });
      tornDown.add(base.agentId);
    } catch (err) {
      console.error("knowledge base teardown failed", base.agentId, err);
    }
  }

  const deleting = await db
    .select({ source: knowledgeSources, bucket: agentKnowledge.bucket, baseStatus: agentKnowledge.status })
    .from(knowledgeSources)
    .innerJoin(agentKnowledge, eq(agentKnowledge.agentId, knowledgeSources.agentId))
    .where(and(eq(knowledgeSources.status, "deleting"), scoped(scope)));
  for (const { source: s, bucket, baseStatus } of deleting) {
    if (baseStatus === "deleting" || tornDown.has(s.agentId)) continue;
    try {
      if (s.type === "url") {
        if (await crawlMayWrite(s, bucket)) continue;
        for (const o of await provider.listObjects(bucket)) if (isCrawledPage(o.key)) await provider.deleteObject(bucket, o.key);
      } else {
        for (const key of objectKeys(s.id)) await provider.deleteObject(bucket, key);
      }
      await db.delete(knowledgeSources).where(eq(knowledgeSources.id, s.id));
    } catch (err) {
      console.error("knowledge source cleanup failed", s.id, err);
    }
  }
}

async function someAsync<T>(items: T[], test: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (await test(item)) return true;
  return false;
}

/**
 * Daily job: settle sources and finish deletions. Deletions run even with the feature off, so a
 * switched-off rollout can't leave data behind; before the tables exist (previews) it does nothing.
 */
export async function runKnowledgeJobs(): Promise<void> {
  try {
    if (config.features.knowledgeBase) await refreshKnowledge();
    else await cleanUpKnowledge();
  } catch (err) {
    console.error("knowledge jobs failed", err);
  }
}

/** Sources counting toward the user's limit, across all agents (a deleted agent's don't, however it was deleted). */
export async function countUserSources(userId: string, q: Queryable = db): Promise<number> {
  const [{ n }] = await q
    .select({ n: count() })
    .from(knowledgeSources)
    .innerJoin(agents, eq(agents.id, knowledgeSources.agentId))
    .where(and(eq(knowledgeSources.userId, userId), ne(knowledgeSources.status, "deleting"), isNull(agents.deletedAt)));
  return n;
}

/** The agent's paid-for sources (deleting the agent deletes them too; failed ones were refunded). */
export async function countAgentSources(agentId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.agentId, agentId), inArray(knowledgeSources.status, ["processing", "ready"])));
  return n;
}

/** Whether the agent has sources still processing or being deleted, which the agent page settles as it renders. */
export async function hasPendingKnowledge(agentId: string): Promise<boolean> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.agentId, agentId), inArray(knowledgeSources.status, ["processing", "deleting"])));
  return n > 0;
}
