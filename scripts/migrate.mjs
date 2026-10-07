// Applies pending Drizzle migrations. Runs as part of `vercel-build`.
// Only production builds migrate: preview deploys share the production
// database (Neon integration), so an unmerged branch must never change its schema.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (process.env.VERCEL && process.env.VERCEL_ENV !== "production") {
  console.log(`[migrate] skipped for VERCEL_ENV=${process.env.VERCEL_ENV}`);
  process.exit(0);
}

// Migrations use a direct connection, not the pooler.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log("[migrate] database is up to date");
} finally {
  await sql.end();
}
