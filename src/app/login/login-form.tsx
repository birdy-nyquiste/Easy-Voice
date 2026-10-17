"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { SubmitButton, safeAction } from "@/components/forms";
import { inputClass } from "@/components/ui";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const t = useTranslations("login");
  const tErrors = useTranslations("errors");
  const [state, action] = useActionState<LoginState, FormData>(safeAction(loginAction, tErrors("network")), { step: "email" });
  return (
    <form action={action} className="space-y-3">
      <input
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder="you@example.com"
        defaultValue={state.email}
        readOnly={state.step === "code"}
        className={`${inputClass} read-only:bg-stone-100`}
      />
      {state.step === "code" && (
        <>
          <p className="text-sm text-stone-600">{t("codeSent", { email: state.email ?? "" })}</p>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            placeholder="123456"
            className={`${inputClass} text-center font-mono text-lg tracking-[0.5em]`}
          />
        </>
      )}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex flex-col gap-2">
        <SubmitButton pendingText={state.step === "email" ? t("sending") : t("verifying")}>
          {state.step === "email" ? t("sendCode") : t("signIn")}
        </SubmitButton>
        {state.step === "code" && (
          <button name="intent" value="send" className="text-sm text-stone-500 hover:text-stone-800" formNoValidate>
            {t("resend")}
          </button>
        )}
      </div>
    </form>
  );
}
