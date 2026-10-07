import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requiredEnv } from "@/lib/env";
import * as schema from "./schema";

const url = requiredEnv("DATABASE_URL", "postgres://localhost:5432/easy_voice");

const globalForDb = globalThis as unknown as { pg?: postgres.Sql };
// prepare: false — DATABASE_URL on Vercel is Neon's pooled (PgBouncer) endpoint,
// which doesn't reliably support named prepared statements.
const client = globalForDb.pg ?? postgres(url, { max: 10, prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.pg = client;

export const db = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };

/** Anything that can run queries: the pool or an open transaction. */
export type Queryable = Db | Tx;

/**
 * Run `fn` in a transaction holding a per-user advisory lock, so
 * check-then-insert sequences (resource limits, one active call) can't race.
 */
export async function withUserLock<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    return fn(tx);
  });
}
