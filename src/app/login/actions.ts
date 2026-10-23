"use server";

import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { errorText } from "@/lib/errors";
import { logout, requestEmailOtp, verifyEmailOtp } from "@/server/auth";

export type LoginState = {
  step: "email" | "code";
  email?: string;
  error?: string;
  /** A new code went out from the code step, so the form says so (an earlier code no longer works). */
  resent?: boolean;
};

export async function loginAction(prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "");
  const locale = await getLocale();
  if (form.get("intent") === "change") return { step: "email", email };
  if (form.get("intent") === "send" || prev.step === "email") {
    const r = await requestEmailOtp(email, locale);
    if (r.ok) return prev.step === "code" ? { step: "code", email, resent: true } : { step: "code", email };
    // A failed resend keeps the code field (a code sent earlier still works) and the "only the newest
    // code works" note when codes were already resent.
    return { step: prev.step, email, resent: prev.resent, error: errorText(locale, r.error) };
  }
  const r = await verifyEmailOtp(email, String(form.get("code") ?? ""));
  // Keep the "only the newest code works" note: a wrong code after a resend is often the old one.
  if (!r.ok) return { step: "code", email, resent: prev.resent, error: errorText(locale, r.error) };
  redirect("/dashboard");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}
