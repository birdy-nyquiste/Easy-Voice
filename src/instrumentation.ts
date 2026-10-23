import { isProductionRuntime } from "@/lib/env";

/** Settings a production server can't run without; each is also read through requiredEnv where it's used. */
const REQUIRED = ["DATABASE_URL", "AUTH_SECRET", "CRON_SECRET", "APP_URL", "RESEND_API_KEY", "EMAIL_FROM"];

/**
 * Runs once when a server starts. Checking the required settings here makes a deploy that lacks one
 * fail straight away, rather than at the first sign-in, top-up or cron run that reads it.
 */
export function register() {
  if (!isProductionRuntime()) return;
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
