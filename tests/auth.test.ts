import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { emailOtps, sessions } from "@/db/schema";
import { loginAction } from "@/app/login/actions";
import { requestEmailOtp, verifyEmailOtp } from "@/server/auth";
import { resetDb } from "./helpers";

const sent: string[] = [];
vi.mock("@/server/email", () => ({
  sendEmail: async (msg: { text: string }) => {
    sent.push(msg.text);
  },
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
// Signing in sets the session cookie; outside a request there is no cookie store.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const email = "someone@example.com";

/** Request a code and return it as the email showed it. */
async function requestCode(): Promise<string> {
  expect(await requestEmailOtp(email, "en")).toEqual({ ok: true });
  return sent.at(-1)!.match(/\d{6}/)![0];
}

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});

describe("email address check", () => {
  it("accepts ordinary addresses and rejects malformed ones", async () => {
    for (const ok of ["a@b.co", "First.Last+tag@mail.example.co.uk"]) {
      expect(await requestEmailOtp(ok, "en")).toEqual({ ok: true });
    }
    for (const bad of ["a@b", "a@b.", "a@.b", "a@b..c", "a b@c.d", "a@b@c.d", ""]) {
      expect(await requestEmailOtp(bad, "en")).toEqual({ ok: false, error: "invalidEmail" });
    }
  });

  it("rejects input built to make the pattern backtrack, at once", async () => {
    const started = performance.now();
    for (const attack of ["a@" + "a.".repeat(500_000) + "@", "a@" + "a.".repeat(120) + "@"]) {
      expect(await requestEmailOtp(attack, "en")).toEqual({ ok: false, error: "invalidEmail" });
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("rejects addresses longer than 254 characters", async () => {
    const long = `${"a".repeat(64)}@${"b".repeat(185)}.com`;
    expect(long).toHaveLength(254);
    expect(await requestEmailOtp(long, "en")).toEqual({ ok: true });
    expect(await requestEmailOtp(`a${long}`, "en")).toEqual({ ok: false, error: "invalidEmail" });
  });
});

describe("sign-in codes", () => {
  it("signs in with the right code, once", async () => {
    const code = await requestCode();
    expect(await verifyEmailOtp(email, code)).toEqual({ ok: true });
    expect(await verifyEmailOtp(email, code)).toEqual({ ok: false, error: "codeExpired" });
  });

  it("allows five guesses per code", async () => {
    const code = await requestCode();
    for (let i = 0; i < 5; i++) expect(await verifyEmailOtp(email, wrong(code))).toEqual({ ok: false, error: "codeIncorrect" });
    expect(await verifyEmailOtp(email, code)).toEqual({ ok: false, error: "codeExpired" });
  });

  it("allows five guesses per code even when they arrive at once", async () => {
    const code = await requestCode();
    const results = await Promise.all(Array.from({ length: 30 }, () => verifyEmailOtp(email, wrong(code))));
    expect(results.filter((r) => !r.ok && r.error === "codeIncorrect")).toHaveLength(5);
    const [row] = await db.select().from(emailOtps).where(eq(emailOtps.email, email));
    expect(row.attempts).toBe(5);
    expect(await verifyEmailOtp(email, code)).toEqual({ ok: false, error: "codeExpired" });
  });

  it("lets only one of several simultaneous correct entries sign in", async () => {
    const code = await requestCode();
    const results = await Promise.all(Array.from({ length: 5 }, () => verifyEmailOtp(email, code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it("sends at most five codes an hour, even when requested at once", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => requestEmailOtp(email, "en")));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.error === "tooManyCodes")).toHaveLength(7);
    expect(await db.select().from(emailOtps).where(eq(emailOtps.email, email))).toHaveLength(5);
  });
});

describe("login form steps", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("keeps the code field when a resend hits the hourly limit, so an earlier code can still be entered", async () => {
    for (let i = 0; i < 5; i++) await requestEmailOtp(email, "en");
    const state = await loginAction({ step: "code", email }, form({ email, intent: "send" }));
    expect(state).toEqual({ step: "code", email, error: "Too many codes requested. Try again later." });
  });

  it("goes back to the email step to use a different address", async () => {
    expect(await loginAction({ step: "code", email }, form({ email, intent: "change" }))).toEqual({ step: "email", email });
    expect(sent).toHaveLength(0);
  });
});
