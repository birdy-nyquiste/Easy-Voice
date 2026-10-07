"use server";

import { redirect } from "next/navigation";
import { logout, requestEmailOtp, verifyEmailOtp } from "@/server/auth";

export type LoginState = { step: "email" | "code"; email?: string; error?: string };

export async function loginAction(prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "");
  if (form.get("intent") === "send" || prev.step === "email") {
    const r = await requestEmailOtp(email);
    return r.ok ? { step: "code", email } : { step: "email", email, error: r.error };
  }
  const r = await verifyEmailOtp(email, String(form.get("code") ?? ""));
  if (!r.ok) return { step: "code", email, error: r.error };
  redirect("/dashboard");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}
