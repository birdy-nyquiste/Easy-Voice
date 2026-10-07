import "server-only";
import { and, isNotNull, lt, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls, phoneNumbers, users } from "@/db/schema";
import { config } from "@/lib/config";
import { purgeCallContent } from "./calls";
import { chargeNumberRenewals, refreshPendingNumbers, releaseNumber } from "./numbers";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily maintenance: renewals, grace-period releases, retention purge, stuck orders. */
export async function runDailyJobs(now = new Date()) {
  await refreshPendingNumbers();
  const renewed = await chargeNumberRenewals(now);

  // Release numbers of users whose balance has been negative past the grace period.
  const cutoff = new Date(now.getTime() - config.policy.negativeBalanceReleaseDays * DAY_MS);
  const delinquent = await db
    .select({ numberId: phoneNumbers.id, userId: phoneNumbers.userId })
    .from(phoneNumbers)
    .innerJoin(users, eq(users.id, phoneNumbers.userId))
    .where(and(eq(phoneNumbers.status, "active"), isNotNull(users.negativeSince), lt(users.negativeSince, cutoff)));
  for (const d of delinquent) {
    await releaseNumber(d.userId, d.numberId, "Released: balance stayed negative past the grace period");
  }

  // Retention: drop recordings/transcripts older than RETENTION_DAYS.
  const retentionCutoff = new Date(now.getTime() - config.policy.retentionDays * DAY_MS);
  const expired = await db
    .select()
    .from(calls)
    .where(and(lt(calls.createdAt, retentionCutoff), isNotNull(calls.endedAt)));
  let purged = 0;
  for (const c of expired) {
    if (!c.transcript && !c.summary && !c.hasRecording) continue;
    await purgeCallContent(c);
    purged++;
  }

  return { renewed, released: delinquent.length, purged };
}
