/** A production server, as opposed to dev, tests or `next build` (which CI runs without production secrets). */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";
}

/**
 * Read a required setting. Dev and test fall back to `devDefault`; a production
 * server refuses to run without it rather than silently using an insecure default.
 * `next build` is exempt so CI can build without production secrets.
 */
export function requiredEnv(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProductionRuntime()) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
}

/**
 * Read a whole-number setting (cents, days). Empty falls back. Anything but digits is refused:
 * parseInt would quietly turn a price of "0.15" into 0 and "15c" into 15.
 */
export function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Env ${name} must be a whole number, not "${raw}"`);
  const n = Number(raw);
  if (n < min) throw new Error(`Env ${name} must be at least ${min}`);
  return n;
}

/**
 * Read a setting that is one of a few words, e.g. TELNYX_MODE. Case and surrounding spaces don't
 * matter and empty falls back; anything else is refused, since "Live" quietly meaning "not live"
 * would run production on the mock without saying so.
 */
export function choiceEnv<T extends string>(name: string, choices: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(choices as readonly string[]).includes(raw)) throw new Error(`Env ${name} must be one of ${choices.join(", ")}, not "${process.env[name]}"`);
  return raw as T;
}
