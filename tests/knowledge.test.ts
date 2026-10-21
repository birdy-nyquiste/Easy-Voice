import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { agentKnowledge, agents, knowledgeSources, ledgerEntries, users } from "@/db/schema";
import { config } from "@/lib/config";
import { errorText } from "@/lib/errors";
import { agentFingerprint, deleteAgent, KNOWLEDGE_RULES, resyncStaleAgents, updateAgent } from "@/server/agents";
import {
  addFileSource,
  addTextSource,
  addUrlSource,
  cleanUpKnowledge,
  deleteSource,
  getAgentKnowledge,
  knowledgeBucketName,
  refreshKnowledge,
  runKnowledgeJobs,
  setKnowledgeMode,
} from "@/server/knowledge";
import { mockKnowledge, mockProvider } from "@/server/telnyx/mock";
import type { AssistantSpec } from "@/server/telnyx/types";
import { makeLine, makeUser, resetDb } from "./helpers";

const knobs = { ...mockKnowledge };
const price = config.pricing.knowledgeSourceCents;
beforeEach(async () => {
  await resetDb();
  mockKnowledge.delayMs = 0;
});
afterEach(() => {
  Object.assign(mockKnowledge, knobs);
  config.pricing.knowledgeSourceCents = price;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const text = (title = "Hours") => ({ title, text: "We open at 7:15 am on weekdays." });

async function balance(userId: string) {
  const [u] = await db.select({ b: users.balanceCents }).from(users).where(eq(users.id, userId));
  return u.b;
}

/** Specs sent to the provider from now on. */
function captureSpecs() {
  const specs: AssistantSpec[] = [];
  vi.spyOn(mockProvider, "updateAssistant").mockImplementation(async (_id, spec) => {
    if (spec.knowledgeBucket && mockKnowledge.rejectRetrieval) throw new Error("rejected");
    specs.push(spec);
  });
  return specs;
}

describe("adding sources", () => {
  it("charges once, embeds the bucket and gives the agent the retrieval tool", async () => {
    const { user, agent } = await makeLine(1000);
    const specs = captureSpecs();
    const s = await addTextSource(user.id, agent.id, text());
    expect(s.status).toBe("processing");
    expect(await balance(user.id)).toBe(1000 - config.pricing.knowledgeSourceCents);

    await refreshKnowledge({ agentId: agent.id });
    const [ready] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, s.id));
    expect(ready.status).toBe("ready");

    const bucket = knowledgeBucketName(agent.id);
    expect(await mockProvider.listObjects(bucket)).toEqual([{ key: `src/${s.id}.txt`, sizeBytes: expect.any(Number) }]);
    const last = specs.at(-1)!;
    expect(last.knowledgeBucket).toBe(bucket);
    expect(last.instructions).toContain(KNOWLEDGE_RULES.reference);

    const [entry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, s.id));
    expect(entry.kind).toBe("knowledge_source");
    // Nothing from the source itself in the ledger.
    expect(entry.description).not.toContain("Hours");
  });

  it("limits sources per user across agents, and adds per day", async () => {
    const { user, agent } = await makeLine(5000);
    for (let i = 0; i < config.limits.knowledgeSources; i++) await addTextSource(user.id, agent.id, text(`T${i}`));
    await expect(addTextSource(user.id, agent.id, text())).rejects.toThrow(errorText("en", "knowledgeLimit", { max: config.limits.knowledgeSources }));
    // Deleting frees the slots but not the day's adds.
    for (const s of await db.select().from(knowledgeSources)) await deleteSource(user.id, s.id);
    await expect(addTextSource(user.id, agent.id, text())).rejects.toThrow(
      errorText("en", "knowledgeDailyLimit", { max: config.limits.knowledgeAddsPerDay }),
    );
  });

  it("refuses when the balance can't pay, writing nothing", async () => {
    const { user, agent } = await makeLine(config.pricing.knowledgeSourceCents - 1);
    await expect(addTextSource(user.id, agent.id, text())).rejects.toThrow(/Insufficient balance/);
    expect(await db.select().from(knowledgeSources)).toEqual([]);
  });

  it("checks file types and sizes before charging", async () => {
    const { user, agent } = await makeLine(1000);
    await expect(addFileSource(user.id, agent.id, new File(["x"], "notes.docx"))).rejects.toThrow(errorText("en", "knowledgeFileType"));
    await expect(addFileSource(user.id, agent.id, new File(["not a pdf"], "fake.pdf"))).rejects.toThrow(errorText("en", "knowledgeFileType"));
    const long = "a".repeat(config.limits.knowledgeFileChars + 1);
    await expect(addFileSource(user.id, agent.id, new File([long], "big.md"))).rejects.toThrow(/characters/);
    const md = await addFileSource(user.id, agent.id, new File(["# Menu\nTea"], "menu.md"));
    expect(await mockProvider.listObjects(knowledgeBucketName(agent.id))).toEqual([{ key: `src/${md.id}.txt`, sizeBytes: 10 }]);
    expect(await balance(user.id)).toBe(1000 - config.pricing.knowledgeSourceCents);
  });

  it("refunds a source that can't be read, exactly once", async () => {
    const { user, agent } = await makeLine(1000);
    const s = await addTextSource(user.id, agent.id, { title: "Bad", text: "mock:unreadable" });
    await refreshKnowledge();
    await refreshKnowledge();
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, s.id));
    expect(row.status).toBe("failed");
    expect(row.failureMsg).toEqual({ key: "stored.knowledgeUnreadable" });
    expect(await balance(user.id)).toBe(1000);
  });

  it("fails and refunds when no bucket can be created", async () => {
    const { user, agent } = await makeLine(1000);
    mockKnowledge.bucketLimitReached = true;
    const s = await addTextSource(user.id, agent.id, text());
    expect(s.status).toBe("failed");
    expect(s.failureMsg).toEqual({ key: "stored.knowledgeBucketsFull" });
    expect(await balance(user.id)).toBe(1000);
  });
});

describe("settling", () => {
  it("settles a failure once when the page and the daily job race", async () => {
    const { user, agent } = await makeLine(1000);
    await addTextSource(user.id, agent.id, { title: "Bad", text: "mock:unreadable" });
    await Promise.all([refreshKnowledge({ agentId: agent.id }), refreshKnowledge(), runKnowledgeJobs()]);
    expect(await balance(user.id)).toBe(1000);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, "refund"))).toHaveLength(1);
  });

  it("refunds the price that was charged, not the current one", async () => {
    const { user, agent } = await makeLine(1000);
    await addTextSource(user.id, agent.id, { title: "Bad", text: "mock:unreadable" });
    config.pricing.knowledgeSourceCents = price * 3;
    await refreshKnowledge();
    expect(await balance(user.id)).toBe(1000);
  });

  it("doesn't refund a source deleted while it was processing", async () => {
    const { user, agent } = await makeLine(1000);
    mockKnowledge.delayMs = 60_000;
    const s = await addTextSource(user.id, agent.id, { title: "Bad", text: "mock:unreadable" });
    await deleteSource(user.id, s.id);
    mockKnowledge.delayMs = 0;
    await refreshKnowledge();
    expect(await balance(user.id)).toBe(1000 - price);
    expect(await db.select().from(knowledgeSources)).toEqual([]);
  });

  it("fails and refunds a source that never reached the provider", async () => {
    const { user, agent } = await makeLine(1000);
    const s = await addTextSource(user.id, agent.id, text());
    // As if the server stopped before the upload: nothing at the provider, and an hour has passed.
    await mockProvider.deleteObject(knowledgeBucketName(agent.id), `src/${s.id}.txt`);
    await db.update(knowledgeSources).set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(knowledgeSources.id, s.id));
    await refreshKnowledge();
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, s.id));
    expect(row).toMatchObject({ status: "failed", failureMsg: { key: "stored.knowledgeUploadFailed" } });
    expect(await balance(user.id)).toBe(1000);
  });
});

describe("website sources", () => {
  it("is ready once the crawl finishes within limits", async () => {
    const { user, agent } = await makeLine(1000);
    const s = await addUrlSource(user.id, agent.id, "https://example.com");
    await refreshKnowledge();
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, s.id));
    expect(row.status).toBe("ready");
    expect(row.sizeBytes).toBe(6000);
    await expect(addUrlSource(user.id, agent.id, "https://example.org")).rejects.toThrow(errorText("en", "knowledgeOneUrl"));
  });

  it("deletes an oversized crawl without a refund", async () => {
    const { user, agent } = await makeLine(1000);
    const s = await addUrlSource(user.id, agent.id, "https://too-large.example.com");
    await refreshKnowledge();
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, s.id));
    expect(row.failureMsg).toEqual({ key: "stored.knowledgeSiteTooLarge" });
    expect(await mockProvider.listObjects(knowledgeBucketName(agent.id))).toEqual([]);
    expect(await balance(user.id)).toBe(1000 - config.pricing.knowledgeSourceCents);
  });

  it("refunds a crawl that finds nothing", async () => {
    const { user, agent } = await makeLine(1000);
    await addUrlSource(user.id, agent.id, "https://empty.example.com");
    await refreshKnowledge();
    expect(await balance(user.id)).toBe(1000);
  });

  it("keeps a website deleted mid-submission until its crawl ends, then removes its pages", async () => {
    const { user, agent } = await makeLine(1000);
    mockKnowledge.delayMs = 60_000;
    const crawl = mockProvider.crawlUrl.bind(mockProvider);
    vi.spyOn(mockProvider, "crawlUrl").mockImplementation(async (bucket, url) => {
      // Deleted before the crawl's task id is recorded.
      const [s] = await db.select().from(knowledgeSources);
      await deleteSource(user.id, s.id);
      return crawl(bucket, url);
    });
    await addUrlSource(user.id, agent.id, "https://example.com");
    const [pending] = await db.select().from(knowledgeSources);
    expect(pending).toMatchObject({ status: "deleting", url: null, crawlTaskId: expect.any(String) });
    expect((await mockProvider.listObjects(knowledgeBucketName(agent.id))).length).toBe(3);

    mockKnowledge.delayMs = 0;
    await cleanUpKnowledge();
    expect(await db.select().from(knowledgeSources)).toEqual([]);
    expect(await mockProvider.listObjects(knowledgeBucketName(agent.id))).toEqual([]);
  });

  it("cleans up one user's crawl without touching another's", async () => {
    const a = await makeLine(1000);
    const b = await makeLine(1000);
    const sa = await addUrlSource(a.user.id, a.agent.id, "https://example.com");
    await addUrlSource(b.user.id, b.agent.id, "https://example.com");
    await refreshKnowledge();
    await deleteSource(a.user.id, sa.id);
    expect(await mockProvider.listObjects(knowledgeBucketName(a.agent.id))).toEqual([]);
    expect((await mockProvider.listObjects(knowledgeBucketName(b.agent.id))).length).toBe(3);
  });

  it("rejects addresses that aren't web pages", async () => {
    const { user, agent } = await makeLine(1000);
    await expect(addUrlSource(user.id, agent.id, "file:///etc/passwd")).rejects.toThrow(errorText("en", "knowledgeUrlInvalid"));
  });
});

describe("deleting", () => {
  it("is permanent and not refunded", async () => {
    const { user, agent } = await makeLine(1000);
    const s = await addTextSource(user.id, agent.id, text());
    await deleteSource(user.id, s.id);
    expect(await db.select().from(knowledgeSources)).toEqual([]);
    expect(await mockProvider.listObjects(knowledgeBucketName(agent.id))).toEqual([]);
    expect(await balance(user.id)).toBe(1000 - config.pricing.knowledgeSourceCents);
  });

  it("clears our copy at once and drops the retrieval tool until the provider copy is gone", async () => {
    const { user, agent } = await makeLine(1000);
    const keep = await addTextSource(user.id, agent.id, text("Keep"));
    const s = await addTextSource(user.id, agent.id, text("Gone"));
    await refreshKnowledge();
    const specs = captureSpecs();
    mockKnowledge.failDeletes = true;
    await deleteSource(user.id, s.id);
    const [pending] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, s.id));
    expect(pending).toMatchObject({ status: "deleting", name: null, content: null });
    expect(specs.at(-1)!.knowledgeBucket).toBeUndefined();

    mockKnowledge.failDeletes = false;
    await cleanUpKnowledge();
    await resyncStaleAgents();
    expect((await db.select().from(knowledgeSources)).map((r) => r.id)).toEqual([keep.id]);
    expect(specs.at(-1)!.knowledgeBucket).toBe(knowledgeBucketName(agent.id));
  });

  it("removes a bucket whose embedding was never turned on", async () => {
    const { user, agent } = await makeLine(1000);
    vi.spyOn(mockProvider, "enableEmbedding").mockRejectedValueOnce(new Error("embedding unavailable"));
    const s = await addTextSource(user.id, agent.id, text());
    expect(s.status).toBe("failed");
    expect(await balance(user.id)).toBe(1000);
    await deleteAgent(user.id, agent.id);
    await cleanUpKnowledge();
    await expect(mockProvider.enableEmbedding(knowledgeBucketName(agent.id))).rejects.toThrow(/no bucket/);
  });

  it("finishes deletions with the feature switched off, and refuses new changes", async () => {
    const { user, agent } = await makeLine(1000);
    const s = await addTextSource(user.id, agent.id, text());
    await deleteAgent(user.id, agent.id);
    vi.stubEnv("KNOWLEDGE_BASE", "off");
    await expect(deleteSource(user.id, s.id)).rejects.toThrow(errorText("en", "notAvailable"));
    await runKnowledgeJobs();
    expect(await db.select().from(agentKnowledge)).toEqual([]);
  });

  it("removes the whole knowledge base with the agent", async () => {
    const { user, agent } = await makeLine(1000);
    await addTextSource(user.id, agent.id, text());
    await deleteAgent(user.id, agent.id);
    await cleanUpKnowledge();
    expect(await db.select().from(knowledgeSources)).toEqual([]);
    expect(await db.select().from(agentKnowledge)).toEqual([]);
    await expect(mockProvider.enableEmbedding(knowledgeBucketName(agent.id))).rejects.toThrow(/no bucket/);
  });
});

describe("agent sync", () => {
  it("applies the strict rule, and no tool when switched off", async () => {
    const { user, agent } = await makeLine(1000);
    await addTextSource(user.id, agent.id, text());
    const specs = captureSpecs();
    await setKnowledgeMode(user.id, agent.id, "strict");
    expect(specs.at(-1)!.instructions).toContain(KNOWLEDGE_RULES.strict);
    await setKnowledgeMode(user.id, agent.id, "off");
    expect(specs.at(-1)!.knowledgeBucket).toBeUndefined();
    expect(specs.at(-1)!.instructions).not.toContain(KNOWLEDGE_RULES.strict);
  });

  it("never takes the agent offline over a knowledge-base problem", async () => {
    const { user, agent } = await makeLine(1000);
    await addTextSource(user.id, agent.id, text());
    captureSpecs();
    mockKnowledge.rejectRetrieval = true;
    await setKnowledgeMode(user.id, agent.id, "strict");
    const [quiet] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(quiet.status).toBe("ready");

    // Saving the agent falls back to pushing it without the knowledge base.
    const saved = await updateAgent(user.id, agent.id, {
      name: "Test agent",
      instructions: "Be helpful",
      greeting: "Hello",
      language: "en",
      voice: "stock:Telnyx.KokoroTTS.af_heart",
    });
    expect(saved.status).toBe("ready");
    // Pushed without the knowledge base, so it shows as not applied and is retried.
    expect(saved.syncedConfig).toBe(agentFingerprint());
    expect((await getAgentKnowledge(saved)).notApplied).toBe(true);
  });

  it("drops the tool everywhere when the feature is switched off", async () => {
    const { user, agent } = await makeLine(1000);
    await addTextSource(user.id, agent.id, text());
    const specs = captureSpecs();
    vi.stubEnv("KNOWLEDGE_BASE", "off");
    expect(await resyncStaleAgents()).toBe(1);
    expect(specs.at(-1)!.knowledgeBucket).toBeUndefined();
  });
});

describe("isolation", () => {
  it("keeps users out of each other's knowledge bases", async () => {
    const a = await makeLine(1000);
    const b = await makeLine(1000);
    const s = await addTextSource(a.user.id, a.agent.id, text());
    await expect(deleteSource(b.user.id, s.id)).rejects.toThrow(errorText("en", "knowledgeSourceNotFound"));
    await expect(addTextSource(b.user.id, a.agent.id, text())).rejects.toThrow(errorText("en", "agentNotFound"));
    await expect(setKnowledgeMode(b.user.id, a.agent.id, "off")).rejects.toThrow(errorText("en", "knowledgeNotFound"));

    const specs = captureSpecs();
    await addTextSource(b.user.id, b.agent.id, text());
    expect(specs.map((x) => x.knowledgeBucket)).toEqual([knowledgeBucketName(b.agent.id)]);
    const [bAgent] = await db.select().from(agents).where(eq(agents.id, b.agent.id));
    expect((await getAgentKnowledge(bAgent)).sources.map((x) => x.id)).not.toContain(s.id);
  });

  it("needs an agent the user owns", async () => {
    const u = await makeUser(1000);
    await expect(addTextSource(u.id, "00000000-0000-0000-0000-000000000000", text())).rejects.toThrow(errorText("en", "agentNotFound"));
  });
});
