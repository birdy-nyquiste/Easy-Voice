import { requiredEnv } from "./env";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer`);
  return n;
}

export const config = {
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  get authSecret() {
    return requiredEnv("AUTH_SECRET", "dev-insecure-secret");
  },
  get cronSecret() {
    return requiredEnv("CRON_SECRET", "");
  },
  /** Dev-only shortcut to credit a balance without paying. Never available in production builds. */
  get devCreditEnabled() {
    return process.env.NODE_ENV !== "production";
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.EMAIL_FROM ?? "Easy Voice <login@example.com>",
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    get enabled() {
      return Boolean(this.secretKey);
    },
  },

  telnyx: {
    // Production defaults to live so a missing env var can't silently simulate telephony.
    mode: (process.env.TELNYX_MODE ?? (process.env.NODE_ENV === "production" ? "live" : "mock")) as "mock" | "live",
    apiKey: process.env.TELNYX_API_KEY ?? "",
    publicKey: process.env.TELNYX_PUBLIC_KEY ?? "",
    connectionId: process.env.TELNYX_CONNECTION_ID ?? "",
    /**
     * Platform-fixed model choices (SPEC §16). Pinned so a change to Telnyx's own
     * defaults can't silently change agent behaviour. Empty env values fall back too.
     * STT: deepgram/nova-3 in "auto" mode transcribed Mandarin as English words in a
     * live test; AssemblyAI handled English, Mandarin and mixed speech.
     */
    llmModel: process.env.TELNYX_LLM_MODEL || "moonshotai/Kimi-K2.6",
    sttModel: process.env.TELNYX_STT_MODEL || "assemblyai/universal-3-5-pro",
    sttLanguage: process.env.TELNYX_STT_LANGUAGE || "auto",
    cloneModel: process.env.TELNYX_CLONE_MODEL ?? "Qwen3TTS",
    /** Insight group with a "summary" insight; summaries are skipped when unset. */
    insightGroupId: process.env.TELNYX_INSIGHT_GROUP_ID ?? "",
  },

  pricing: {
    callPerMinuteCents: int("PRICE_CALL_PER_MINUTE_CENTS", 15),
    numberMonthlyCents: int("PRICE_NUMBER_MONTHLY_CENTS", 300),
    voiceCloneCents: int("PRICE_VOICE_CLONE_CENTS", 500),
    minTopupCents: int("MIN_TOPUP_CENTS", 1000),
  },

  policy: {
    negativeBalanceReleaseDays: int("NEGATIVE_BALANCE_RELEASE_DAYS", 7),
    retentionDays: int("RETENTION_DAYS", 30),
  },

  limits: {
    numbersPerUser: 1,
    agentsPerUser: 3,
    clonedVoicesPerUser: 2,
    // Vercel rejects function request bodies over 4.5 MB (serverActions.bodySizeLimit matches);
    // leave headroom for the other form fields and multipart overhead.
    cloneSampleBytes: 4.4 * 1024 * 1024,
    concurrentCalls: 1,
  },
};

export const SESSION_COOKIE = "ev_session";
