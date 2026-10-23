import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { emailOtps, sessions } from "@/db/schema";
import { GET as googleCallback } from "@/app/api/auth/google/callback/route";
import { loginAction } from "@/app/login/actions";
import { oauthErrorKey } from "@/app/login/oauth-error";
import { createSession, getCurrentUser, logout, requestEmailOtp, upsertUser, verifyEmailOtp } from "@/server/auth";
import { resetDb } from "./helpers";

const sent: string[] = [];
/** Set to make the next emails fail, as Resend does in an outage or for a rejected address. */
let sendFails = false;
vi.mock("@/server/email", () => ({
  sendEmail: async (msg: { text: string }) => {
    if (sendFails) throw new Error("Resend 422");
    sent.push(msg.text);
  },
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
// Signing in sets the session cookie; outside a request there is no cookie store, so keep one here.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
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
  sendFails = false;
  jar.clear();
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

  it("allows five guesses per code, then says the tries ran out", async () => {
    const code = await requestCode();
    for (let i = 0; i < 5; i++) expect(await verifyEmailOtp(email, wrong(code))).toEqual({ ok: false, error: "codeIncorrect" });
    expect(await verifyEmailOtp(email, code)).toEqual({ ok: false, error: "tooManyAttempts" });
    // A new code gets its own tries.
    expect(await verifyEmailOtp(email, await requestCode())).toEqual({ ok: true });
  });

  it("allows five guesses per code even when they arrive at once", async () => {
    const code = await requestCode();
    const results = await Promise.all(Array.from({ length: 30 }, () => verifyEmailOtp(email, wrong(code))));
    expect(results.filter((r) => !r.ok && r.error === "codeIncorrect")).toHaveLength(5);
    const [row] = await db.select().from(emailOtps).where(eq(emailOtps.email, email));
    expect(row.attempts).toBe(5);
    expect(await verifyEmailOtp(email, code)).toEqual({ ok: false, error: "tooManyAttempts" });
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

  it("doesn't count a code whose email failed to send toward the hourly limit", async () => {
    sendFails = true;
    for (let i = 0; i < 5; i++) expect(await requestEmailOtp(email, "en")).toEqual({ ok: false, error: "emailSendFailed" });
    expect(await db.select().from(emailOtps)).toHaveLength(0);
    sendFails = false;
    expect(await verifyEmailOtp(email, await requestCode())).toEqual({ ok: true });
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

  it("keeps the typed address when the code email can't be sent", async () => {
    sendFails = true;
    expect(await loginAction({ step: "email" }, form({ email }))).toEqual({
      step: "email",
      email,
      error: "We couldn't send the code. Check the address and try again.",
    });
  });

  it("says when a resend went out, and keeps saying only the newest code works after a wrong one", async () => {
    expect(await loginAction({ step: "email" }, form({ email }))).toEqual({ step: "code", email });
    const first = sent.at(-1)!.match(/\d{6}/)![0];
    const resent = await loginAction({ step: "code", email }, form({ email, intent: "send" }));
    expect(resent).toEqual({ step: "code", email, resent: true });
    const newest = sent.at(-1)!.match(/\d{6}/)![0];
    // The first email's code no longer works (in the rare case the two match, any other code will do).
    const old = first === newest ? wrong(newest) : first;
    expect(await loginAction(resent, form({ email, code: old }))).toEqual({ step: "code", email, resent: true, error: "Incorrect code." });
  });
});

describe("Google sign-in", () => {
  /** Where the callback sends the browser, without the app's origin. */
  async function callback(query: string): Promise<string> {
    jar.set("g_state", "s1");
    jar.set("g_verifier", "v1");
    const res = await googleCallback(new NextRequest(`http://localhost:3000/api/auth/google/callback?${query}`));
    const to = new URL(res.headers.get("location")!);
    return to.pathname + to.search;
  }

  it("goes back to sign-in without an error when the user cancels at Google", async () => {
    expect(await callback("error=access_denied&state=s1")).toBe("/login");
    expect(await callback("error=server_error&state=s1")).toBe("/login?error=google_failed");
    expect(await callback("code=c1&state=forged")).toBe("/login?error=google_state");
    expect(jar.size).toBe(0);
  });

  it("shows a known error message only for the codes the callback sends", () => {
    expect(oauthErrorKey("google_state")).toBe("googleState");
    for (const odd of ["constructor", "toString", "__proto__", "hasOwnProperty", "nope"]) expect(oauthErrorKey(odd)).toBe("failed");
  });
});

describe("accounts and sessions", () => {
  it("links Google sign-in to the account with the same email, then finds it by Google id", async () => {
    const byEmail = await upsertUser({ email: "Someone@Example.com " });
    const linked = await upsertUser({ email: email, googleSub: "g-1", name: "Sam" });
    expect(linked).toMatchObject({ id: byEmail.id, googleSub: "g-1", name: "Sam" });
    // Google's id wins even if the email on the Google account changes.
    expect((await upsertUser({ email: "renamed@example.com", googleSub: "g-1" })).id).toBe(byEmail.id);
  });

  it("signs in with a session cookie, which stops working once it expires or after signing out", async () => {
    const user = await upsertUser({ email });
    await createSession(user);
    expect((await getCurrentUser())?.id).toBe(user.id);
    // Only a hash of the token is stored.
    const [row] = await db.select().from(sessions);
    expect(row.id).not.toBe(jar.get("ev_session"));

    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getCurrentUser()).toBeNull();

    await createSession(user);
    await logout();
    expect(await getCurrentUser()).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1); // only the expired one
  });
});
