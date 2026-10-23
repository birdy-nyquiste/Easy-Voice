import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { config } from "@/lib/config";
import { choiceEnv, intEnv, requiredEnv } from "@/lib/env";
import { sendEmail } from "@/server/email";

afterEach(() => vi.unstubAllEnvs());

describe("requiredEnv", () => {
  it("returns the value when set", () => {
    vi.stubEnv("SOME_SECRET", "abc");
    expect(requiredEnv("SOME_SECRET", "dev")).toBe("abc");
  });

  it("falls back to the dev default outside production", () => {
    vi.stubEnv("SOME_SECRET", "");
    expect(requiredEnv("SOME_SECRET", "dev")).toBe("dev");
  });

  it("refuses to run a production server without it", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SOME_SECRET", "");
    expect(() => requiredEnv("SOME_SECRET", "dev")).toThrow(/Missing required environment variable SOME_SECRET/);
  });

  it("lets `next build` proceed without production secrets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("SOME_SECRET", "");
    expect(requiredEnv("SOME_SECRET", "dev")).toBe("dev");
  });
});

describe("intEnv", () => {
  it("reads whole numbers and falls back when unset or empty", () => {
    vi.stubEnv("SOME_PRICE", " 15 ");
    expect(intEnv("SOME_PRICE", 7)).toBe(15);
    vi.stubEnv("SOME_PRICE", "");
    expect(intEnv("SOME_PRICE", 7)).toBe(7);
  });

  it("refuses decimals, junk and negative values instead of reading their leading digits", () => {
    for (const raw of ["0.15", "10.00", "1e3", "15c", "-5", "abc"]) {
      vi.stubEnv("SOME_PRICE", raw);
      expect(() => intEnv("SOME_PRICE", 7), raw).toThrow(/SOME_PRICE must be a whole number/);
    }
  });

  it("enforces a minimum", () => {
    vi.stubEnv("SOME_DAYS", "0");
    expect(() => intEnv("SOME_DAYS", 30, 1)).toThrow(/SOME_DAYS must be at least 1/);
    vi.stubEnv("SOME_DAYS", "1");
    expect(intEnv("SOME_DAYS", 30, 1)).toBe(1);
  });
});

describe("choiceEnv", () => {
  const MODES = ["mock", "live"] as const;

  it("ignores case and surrounding spaces", () => {
    vi.stubEnv("SOME_MODE", " Live ");
    expect(choiceEnv("SOME_MODE", MODES, "mock")).toBe("live");
  });

  it("falls back when unset or empty", () => {
    vi.stubEnv("SOME_MODE", "");
    expect(choiceEnv("SOME_MODE", MODES, "live")).toBe("live");
  });

  it("refuses anything else rather than quietly running the mock", () => {
    vi.stubEnv("SOME_MODE", "production");
    expect(() => choiceEnv("SOME_MODE", MODES, "live")).toThrow(/SOME_MODE must be one of mock, live/);
  });
});

describe("production settings", () => {
  it("drops a trailing slash from APP_URL, and requires it in production", () => {
    vi.stubEnv("APP_URL", "https://voice.example.com/");
    expect(config.appUrl).toBe("https://voice.example.com");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "");
    expect(() => config.appUrl).toThrow(/APP_URL/);
  });

  it("never prints a sign-in email to the logs in production", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    await expect(sendEmail({ to: "a@example.com", subject: "Your code", text: "123456" })).rejects.toThrow(/RESEND_API_KEY/);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses to start a production server without every required setting", () => {
    const all = { DATABASE_URL: "postgres://db", AUTH_SECRET: "a", CRON_SECRET: "c", APP_URL: "https://x", RESEND_API_KEY: "re_1", EMAIL_FROM: "x@y" };
    for (const [name, value] of Object.entries(all)) vi.stubEnv(name, value);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => register()).not.toThrow();
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("APP_URL", "");
    expect(() => register()).toThrow("Missing required environment variables: APP_URL, RESEND_API_KEY");
    vi.stubEnv("NODE_ENV", "development");
    expect(() => register()).not.toThrow();
  });

  it("keeps top-ups off until the Stripe webhook secret is set too", () => {
    const { secretKey, webhookSecret } = config.stripe;
    try {
      config.stripe.secretKey = "sk_test_dummy";
      config.stripe.webhookSecret = "";
      expect(config.stripe.enabled).toBe(false);
      config.stripe.webhookSecret = "whsec_test";
      expect(config.stripe.enabled).toBe(true);
    } finally {
      Object.assign(config.stripe, { secretKey, webhookSecret });
    }
  });
});
