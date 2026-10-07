/**
 * Read a required setting. Dev and test fall back to `devDefault`; a production
 * server refuses to run without it rather than silently using an insecure default.
 * `next build` is exempt so CI can build without production secrets.
 */
export function requiredEnv(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  const isProductionRuntime =
    process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";
  if (isProductionRuntime) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
}
