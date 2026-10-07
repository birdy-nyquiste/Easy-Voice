import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/easy_voice_test";
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
}
