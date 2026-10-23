import { choiceEnv, intEnv, requiredEnv } from "./env";

const MODES = ["mock", "live"] as const;
// Production defaults to live so a missing env var can't silently simulate telephony.
const telnyxMode = choiceEnv("TELNYX_MODE", MODES, process.env.NODE_ENV === "production" ? "live" : "mock");

export const config = {
  /** Where Google and Stripe send the user back to, without a trailing slash (paths are appended to it). */
  get appUrl() {
    return requiredEnv("APP_URL", "http://localhost:3000").replace(/\/+$/, "");
  },
  get authSecret() {
    return requiredEnv("AUTH_SECRET", "dev-insecure-secret");
  },
  get cronSecret() {
    return requiredEnv("CRON_SECRET", "");
  },
  /**
   * Encrypts API keys users give us (server/secrets.ts). Any string; a 32-byte key is derived from it.
   * Changing it makes stored keys unreadable, so users would have to reconnect.
   */
  get secretsKey() {
    return requiredEnv("SECRETS_KEY", "dev-insecure-secrets-key");
  },
  /** Dev-only shortcut to credit a balance without paying. Never available in production builds. */
  get devCreditEnabled() {
    return process.env.NODE_ENV !== "production";
  },
  /** The production deployment, or not on Vercel at all (local dev, tests). Previews share production's database. */
  get isProductionDeployment() {
    return !process.env.VERCEL || process.env.VERCEL_ENV === "production";
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  email: {
    /** Without it, dev prints emails (sign-in codes included) to the console; production requires it. */
    get resendApiKey() {
      return requiredEnv("RESEND_API_KEY", "");
    },
    /** Resend rejects senders on domains it hasn't verified, so production must set its own. */
    get from() {
      return requiredEnv("EMAIL_FROM", "Easy Voice <login@example.com>");
    },
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    /** Both: without the webhook secret a checkout would take money that no webhook can ever credit. */
    get enabled() {
      return Boolean(this.secretKey && this.webhookSecret);
    },
  },

  telnyx: {
    mode: telnyxMode,
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
    cloneModel: process.env.TELNYX_CLONE_MODEL || "Qwen3TTS",
    /** Insight group with a "summary" insight; summaries are skipped when unset. */
    insightGroupId: process.env.TELNYX_INSIGHT_GROUP_ID ?? "",
    /** Messaging profile whose webhook points at us; numbers are put on it to receive texts. Unset = no texts. */
    messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID ?? "",
  },

  elevenlabs: {
    /** Follows TELNYX_MODE unless set: "mock" simulates ElevenLabs in-process. */
    mode: choiceEnv("ELEVENLABS_MODE", MODES, telnyxMode),
    /**
     * TTS model for ElevenLabs voices on calls. Flash v2.5 is the low-latency phone model (~75 ms,
     * Mandarin + English) and half the credits of Multilingual.
     */
    ttsModel: process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5",
  },

  pricing: {
    callPerMinuteCents: intEnv("PRICE_CALL_PER_MINUTE_CENTS", 15),
    numberMonthlyCents: intEnv("PRICE_NUMBER_MONTHLY_CENTS", 300),
    voiceCloneCents: intEnv("PRICE_VOICE_CLONE_CENTS", 500),
    /**
     * Telnyx charges $0.004/segment plus up to $0.0045 in carrier fees for inbound texts, and may add
     * an unregistered (non-10DLC) carrier fee of ~$0.012; 2¢ stays above the worst case.
     */
    smsInboundPerPartCents: intEnv("PRICE_SMS_INBOUND_PER_PART_CENTS", 2),
    /** One-time charge per knowledge-base source, any type (SPEC §18.2). Embedding a typical source costs Telnyx cents. */
    knowledgeSourceCents: intEnv("PRICE_KNOWLEDGE_SOURCE_CENTS", 100),
    /** Stripe won't charge less than $0.50. */
    minTopupCents: intEnv("MIN_TOPUP_CENTS", 1000, 50),
    maxTopupCents: intEnv("MAX_TOPUP_CENTS", 50_000),
  },

  policy: {
    // At least a day each: 0 would release a number, or purge a call, the moment it qualifies.
    negativeBalanceReleaseDays: intEnv("NEGATIVE_BALANCE_RELEASE_DAYS", 7, 1),
    retentionDays: intEnv("RETENTION_DAYS", 30, 1),
  },

  features: {
    /**
     * Cloning and using cloned voices. Off by default in live mode until the Telnyx account
     * passes L2 verification (unverified accounts can clone but not use clones). VOICE_CLONING=on|off.
     */
    get voiceCloning() {
      const v = process.env.VOICE_CLONING;
      return v ? v === "on" : config.telnyx.mode !== "live";
    },
    /**
     * Cloning with the user's own ElevenLabs key. Independent of VOICE_CLONING: the Telnyx L2
     * restriction is about Telnyx clones. Live mode needs SECRETS_KEY. ELEVENLABS=on|off.
     */
    get elevenLabs() {
      const v = process.env.ELEVENLABS;
      return v ? v === "on" : config.elevenlabs.mode !== "live" || Boolean(process.env.SECRETS_KEY);
    },
    /**
     * Receiving texts (never sending: no 10DLC registration; SPEC §17). Live mode needs a messaging profile.
     */
    get inboundSms() {
      return config.telnyx.mode !== "live" || Boolean(config.telnyx.messagingProfileId);
    },
    /** Per-agent knowledge bases (SPEC §18). Off by default in live mode. KNOWLEDGE_BASE=on|off. */
    get knowledgeBase() {
      const v = process.env.KNOWLEDGE_BASE;
      return v ? v === "on" : config.telnyx.mode !== "live";
    },
    /**
     * Website URLs as knowledge sources. A Telnyx crawl can't be limited or cancelled, so this stays
     * off in live mode until Telnyx confirms a crawl has a ceiling (SPEC §18.4). KNOWLEDGE_BASE_URLS=on|off.
     */
    get knowledgeUrls() {
      const v = process.env.KNOWLEDGE_BASE_URLS;
      return config.features.knowledgeBase && (v ? v === "on" : config.telnyx.mode !== "live");
    },
  },

  limits: {
    numbersPerUser: 1,
    agentsPerUser: 3,
    clonedVoicesPerUser: 2,
    // Vercel rejects function request bodies over 4.5 MB (serverActions.bodySizeLimit matches);
    // leave headroom for the other form fields and multipart overhead.
    cloneSampleBytes: 4.4 * 1024 * 1024,
    concurrentCalls: 1,
    /** Knowledge sources per user, across all agents (SPEC §18.2). */
    knowledgeSources: 5,
    /** Sources a user can add in any 24 hours; deleting one doesn't give it back. */
    knowledgeAddsPerDay: 5,
    knowledgeTextChars: 20_000,
    /** TXT / MD files, in characters: about $0.75 to embed at the most. */
    knowledgeFileChars: 500_000,
    knowledgePdfBytes: 4 * 1024 * 1024,
    /**
     * A crawl that brings in more text than this fails and its pages are deleted. Pages arrive
     * concatenated in ~2 MB chunks, so the number of objects says nothing about the number of pages.
     */
    knowledgeCrawlBytes: 4 * 1024 * 1024,
    /**
     * A crawl is taken to be finished once nothing has been written for this long: Telnyx never says
     * when one ends, and a live crawl wrote again after 10+ quiet minutes (docs/telnyx-api-notes.md §17).
     */
    get knowledgeCrawlQuietMs() {
      return config.telnyx.mode === "live" ? 60 * 60 * 1000 : 5000;
    },
  },
};

export const SESSION_COOKIE = "ev_session";
