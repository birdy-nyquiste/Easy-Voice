import "server-only";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { emailOtps, sessions, users, type User } from "@/db/schema";
import { config, SESSION_COOKIE } from "@/lib/config";
import { sendEmail } from "./email";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hashOtp = (email: string, code: string) => sha256(`${config.authSecret}:${email}:${code}`);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function requestEmailOtp(rawEmail: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailOtps)
    .where(and(eq(emailOtps.email, email), gt(emailOtps.createdAt, new Date(Date.now() - 3600_000))));
  if (count >= OTP_MAX_PER_HOUR) return { ok: false, error: "Too many codes requested. Try again later." };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(emailOtps).values({
    email,
    codeHash: hashOtp(email, code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  await sendEmail({
    to: email,
    subject: `Your Easy Voice code: ${code}`,
    text: `Your sign-in code is ${code}. It expires in 10 minutes.`,
  });
  return { ok: true };
}

export async function verifyEmailOtp(rawEmail: string, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(rawEmail);
  const [otp] = await db
    .select()
    .from(emailOtps)
    .where(and(eq(emailOtps.email, email), isNull(emailOtps.consumedAt), gt(emailOtps.expiresAt, new Date())))
    .orderBy(desc(emailOtps.createdAt))
    .limit(1);
  if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: "Code expired. Request a new one." };

  const expected = Buffer.from(otp.codeHash);
  const actual = Buffer.from(hashOtp(email, code.trim()));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await db.update(emailOtps).set({ attempts: otp.attempts + 1 }).where(eq(emailOtps.id, otp.id));
    return { ok: false, error: "Incorrect code." };
  }
  await db.update(emailOtps).set({ consumedAt: new Date() }).where(eq(emailOtps.id, otp.id));

  const user = await upsertUser({ email });
  await createSession(user.id);
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

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
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
