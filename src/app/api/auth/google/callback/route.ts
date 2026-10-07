import { decodeIdToken } from "arctic";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { createSession, upsertUser } from "@/server/auth";
import { googleClient } from "@/server/google";

export async function GET(req: NextRequest) {
  const fail = (code: string) => NextResponse.redirect(new URL(`/login?error=${code}`, config.appUrl));
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const jar = await cookies();
  const expectedState = jar.get("g_state")?.value;
  const verifier = jar.get("g_verifier")?.value;
  jar.delete("g_state");
  jar.delete("g_verifier");
  if (!code || !state || !verifier || state !== expectedState) return fail("google_state");

  try {
    const tokens = await googleClient().validateAuthorizationCode(code, verifier);
    const claims = decodeIdToken(tokens.idToken()) as {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!claims.email || !claims.email_verified) return fail("google_email");
    const user = await upsertUser({ email: claims.email, name: claims.name, googleSub: claims.sub });
    await createSession(user.id);
  } catch (err) {
    console.error("Google sign-in failed", err);
    return fail("google_failed");
  }
  return NextResponse.redirect(new URL("/dashboard", config.appUrl));
}
