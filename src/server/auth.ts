import "server-only";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, withLock } from "@/db";
import { emailOtps, sessions, users, type User } from "@/db/schema";
import type { Locale } from "@/i18n/locales";
import { translator } from "@/i18n/messages";
import { config, SESSION_COOKIE } from "@/lib/config";
import type { ErrorKey } from "@/lib/errors";
import { sendEmail } from "./email";
import { syncLocaleAtSignIn } from "./locale";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The longest address SMTP allows. */
const MAX_EMAIL_LENGTH = 254;
/**
 * local@label.label…: domain labels can't contain dots, so there is only one way to split the
 * domain and the match runs in linear time (an overlapping pattern backtracked quadratically).
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hashOtp = (email: string, code: string) => sha256(`${config.authSecret}:${email}:${code}`);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

type AuthResult = { ok: true } | { ok: false; error: ErrorKey };

export async function requestEmailOtp(rawEmail: string, locale: Locale): Promise<AuthResult> {
  const email = normalizeEmail(rawEmail);
  // Length first: the login form is public, so the pattern must never see huge input.
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return { ok: false, error: "invalidEmail" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // Count and insert under a per-email lock, so parallel requests can't each pass the hourly limit.
  const otpId = await withLock(`otp:${email}`, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(emailOtps)
      .where(and(eq(emailOtps.email, email), gt(emailOtps.createdAt, new Date(Date.now() - 3600_000))));
    if (count >= OTP_MAX_PER_HOUR) return null;
    const [row] = await tx
      .insert(emailOtps)
      .values({ email, codeHash: hashOtp(email, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) })
      .returning({ id: emailOtps.id });
    return row.id;
  });
  if (!otpId) return { ok: false, error: "tooManyCodes" };
  const t = translator(locale, "email");
  try {
    await sendEmail({ to: email, subject: t("otpSubject", { code }), text: t("otpBody", { code }) });
  } catch (err) {
    // A code that never arrived shouldn't count toward the hourly limit.
    console.error("Sign-in code email failed", err);
    await db.delete(emailOtps).where(eq(emailOtps.id, otpId));
    return { ok: false, error: "emailSendFailed" };
  }
  return { ok: true };
}

export async function verifyEmailOtp(rawEmail: string, code: string): Promise<AuthResult> {
  const email = normalizeEmail(rawEmail);
  const [otp] = await db
    .select()
    .from(emailOtps)
    .where(and(eq(emailOtps.email, email), isNull(emailOtps.consumedAt), gt(emailOtps.expiresAt, new Date())))
    .orderBy(desc(emailOtps.createdAt))
    .limit(1);
  if (!otp) return { ok: false, error: "codeExpired" };

  // Spend the attempt in the database before comparing, so parallel guesses can't all read the same
  // count: at most OTP_MAX_ATTEMPTS comparisons per code, however the requests are timed.
  const [spent] = await db
    .update(emailOtps)
    .set({ attempts: sql`${emailOtps.attempts} + 1` })
    .where(and(eq(emailOtps.id, otp.id), isNull(emailOtps.consumedAt), lt(emailOtps.attempts, OTP_MAX_ATTEMPTS)))
    .returning({ id: emailOtps.id });
  // The code is out of tries (or another request just used it, which is too rare to word apart).
  if (!spent) return { ok: false, error: "tooManyAttempts" };

  const expected = Buffer.from(otp.codeHash);
  const actual = Buffer.from(hashOtp(email, code.trim()));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: "codeIncorrect" };
  }
  // Only one request can consume a code.
  const [consumed] = await db
    .update(emailOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(emailOtps.id, otp.id), isNull(emailOtps.consumedAt)))
    .returning({ id: emailOtps.id });
  if (!consumed) return { ok: false, error: "codeExpired" };

  const user = await upsertUser({ email });
  await createSession(user);
  return { ok: true };
}

/** Find or create the user by Google subject, falling back to verified email. */
export async function upsertUser(input: { email: string; name?: string; googleSub?: string }): Promise<User> {
  const email = normalizeEmail(input.email);
  if (input.googleSub) {
    const [bySub] = await db.select().from(users).where(eq(users.googleSub, input.googleSub));
    if (bySub) return bySub;
  }
  const [byEmail] = await db.select().from(users).where(eq(users.email, email));
  if (byEmail) {
    if (input.googleSub && !byEmail.googleSub) {
      const [updated] = await db
        .update(users)
        .set({ googleSub: input.googleSub, name: byEmail.name ?? input.name })
        .where(eq(users.id, byEmail.id))
        .returning();
      return updated;
    }
    return byEmail;
  }
  const [created] = await db
    .insert(users)
    .values({ email, name: input.name, googleSub: input.googleSub })
    .returning();
  return created;
}

export async function createSession(user: User): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: sha256(token), userId: user.id, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  await syncLocaleAtSignIn(user);
}

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row?.user ?? null;
});

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
  jar.delete(SESSION_COOKIE);
}
