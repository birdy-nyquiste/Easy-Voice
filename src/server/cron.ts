import "server-only";
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { calls, phoneNumbers, users } from "@/db/schema";
import { config } from "@/lib/config";
import { stored } from "@/lib/stored-text";
import { deleteLeftoverAssistants, resyncStaleAgents } from "./agents";
import { purgeExpiredSignIns } from "./auth";
import { finalizeStaleCalls, purgeCallContent } from "./calls";
import { fetchCallResults } from "./calls/results";
import { runKnowledgeJobs } from "./knowledge";
import { enablePendingInboundSms, purgeExpiredMessages } from "./messages";
import { chargeNumberRenewals, refreshPendingNumbers, releaseNumber } from "./numbers";
import { refreshProcessingVoices } from "./voices";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily maintenance: knowledge sources, agent resync, deleted agents' assistants, stuck number orders and
 * clones, grace-period releases, renewals, texting setup, calls whose hangup never came, retention purge
 * (calls and texts), expired sign-ins and missed call results.
 * Each stage runs even if an earlier one fails (a provider error must not hold up the retention
 * purge); failures are logged and reported by throwing once everything has run.
 */
export async function runDailyJobs(now = new Date()) {
  const failed: string[] = [];
  async function stage<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.error(`daily job "${name}" failed`, err);
      failed.push(name);
      return fallback;
    }
  }

  // First, so agents whose knowledge base changed are caught up by the resync below.
  await stage("knowledge", runKnowledgeJobs, undefined);
  const resynced = await stage("resync agents", resyncStaleAgents, 0);
  const assistantsDeleted = await stage("deleted agents' assistants", deleteLeftoverAssistants, 0);
  await stage("pending numbers", refreshPendingNumbers, undefined);
  // Settle voice clones (refunding ones that were never made) for users who don't reopen the Voices page.
  await stage("voice clones", refreshProcessingVoices, undefined);
  // Release numbers of users whose balance has been negative past the grace period. Before renewals,
  // so a number that is being released isn't charged another month first.
  const released = await stage(
    "negative-balance releases",
    async () => {
      const cutoff = new Date(now.getTime() - config.policy.negativeBalanceReleaseDays * DAY_MS);
      const delinquent = await db
        .select({ numberId: phoneNumbers.id, userId: phoneNumbers.userId })
        .from(phoneNumbers)
        .innerJoin(users, eq(users.id, phoneNumbers.userId))
        .where(and(eq(phoneNumbers.status, "active"), isNotNull(users.negativeSince), lt(users.negativeSince, cutoff)));
      let count = 0;
      for (const d of delinquent) {
        try {
          await releaseNumber(d.userId, d.numberId, stored("numberReleasedNegative"));
          count++;
        } catch (err) {
          // Retried tomorrow; the other releases go ahead.
          console.error("negative-balance release failed", d.numberId, err);
          if (!failed.includes("negative-balance releases")) failed.push("negative-balance releases");
        }
      }
      return count;
    },
    0,
  );
  const renewed = await stage("renewals", () => chargeNumberRenewals(now), 0);
  const smsEnabled = await stage("texting setup", enablePendingInboundSms, 0);

  // Calls whose hangup never arrived: end them, so they can be purged below.
  const callsFinalized = await stage("stale calls", () => finalizeStaleCalls(now), 0);

  // Retention: delete recordings/transcripts older than RETENTION_DAYS, here and at the provider.
  const retentionCutoff = new Date(now.getTime() - config.policy.retentionDays * DAY_MS);
  const purged = await stage(
    "call retention",
    async () => {
      const expired = await db
        .select()
        .from(calls)
        .where(and(lt(calls.createdAt, retentionCutoff), isNotNull(calls.endedAt), isNull(calls.purgedAt)));
      let count = 0;
      for (const c of expired) if (await purgeCallContent(c)) count++;
      return count;
    },
    0,
  );
  const messagesPurged = await stage("message retention", () => purgeExpiredMessages(retentionCutoff), 0);
  const signInsPurged = await stage("expired sign-ins", () => purgeExpiredSignIns(now), 0);

  // Results the post-hangup fetch missed (e.g. on serverless). Past RESULTS_WAIT_MS a fetch settles for
  // what there is, so only calls whose fetch keeps failing stay behind; newest first, so those can't
  // crowd out new ones.
  const resultsFetched = await stage(
    "call results",
    async () => {
      const missing = await db
        .select()
        .from(calls)
        .where(and(eq(calls.status, "completed"), eq(calls.resultsFetched, false), isNull(calls.purgedAt)))
        .orderBy(desc(calls.endedAt))
        .limit(200);
      for (const c of missing) await fetchCallResults(c);
      return missing.length;
    },
    0,
  );

  const summary = { renewed, released, callsFinalized, purged, messagesPurged, signInsPurged, resultsFetched, resynced, assistantsDeleted, smsEnabled };
  if (failed.length) throw new Error(`Daily jobs failed: ${failed.join(", ")} (others ran: ${JSON.stringify(summary)})`);
  return summary;
}
