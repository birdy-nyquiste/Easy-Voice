import "server-only";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { calls, phoneNumbers, users } from "@/db/schema";
import { config } from "@/lib/config";
import { stored } from "@/lib/stored-text";
import { resyncStaleAgents } from "./agents";
import { purgeCallContent } from "./calls";
import { fetchCallResults } from "./calls/results";
import { runKnowledgeJobs } from "./knowledge";
import { enablePendingInboundSms, purgeExpiredMessages } from "./messages";
import { chargeNumberRenewals, refreshPendingNumbers, releaseNumber } from "./numbers";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily maintenance: renewals, grace-period releases, retention purge, stuck orders, texting setup. */
export async function runDailyJobs(now = new Date()) {
  // First, so agents whose knowledge base changed are caught up by the resync below.
  await runKnowledgeJobs();
  const resynced = await resyncStaleAgents();
  await refreshPendingNumbers();
  const renewed = await chargeNumberRenewals(now);
  const smsEnabled = await enablePendingInboundSms();

  // Release numbers of users whose balance has been negative past the grace period.
  const cutoff = new Date(now.getTime() - config.policy.negativeBalanceReleaseDays * DAY_MS);
  const delinquent = await db
    .select({ numberId: phoneNumbers.id, userId: phoneNumbers.userId })
    .from(phoneNumbers)
    .innerJoin(users, eq(users.id, phoneNumbers.userId))
    .where(and(eq(phoneNumbers.status, "active"), isNotNull(users.negativeSince), lt(users.negativeSince, cutoff)));
  for (const d of delinquent) {
    await releaseNumber(d.userId, d.numberId, stored("numberReleasedNegative"));
  }

  // Retention: delete recordings/transcripts older than RETENTION_DAYS, here and at the provider.
  const retentionCutoff = new Date(now.getTime() - config.policy.retentionDays * DAY_MS);
  const expired = await db
    .select()
    .from(calls)
    .where(and(lt(calls.createdAt, retentionCutoff), isNotNull(calls.endedAt), isNull(calls.purgedAt)));
  let purged = 0;
  for (const c of expired) if (await purgeCallContent(c)) purged++;
  const messagesPurged = await purgeExpiredMessages(retentionCutoff);

  // Results the post-hangup fetch missed (e.g. on serverless).
  const missing = await db
    .select()
    .from(calls)
    .where(and(eq(calls.status, "completed"), eq(calls.resultsFetched, false), isNull(calls.purgedAt)))
    .limit(200);
  for (const c of missing) await fetchCallResults(c);

  return { renewed, released: delinquent.length, purged, messagesPurged, resultsFetched: missing.length, resynced, smsEnabled };
}
