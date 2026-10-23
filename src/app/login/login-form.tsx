"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { SubmitButton, safeAction } from "@/components/forms";
import { buttonClass, inputClass } from "@/components/ui";
import { loginAction, type LoginState } from "./actions";

const INITIAL: LoginState = { step: "email" };
const ERROR_ID = "login-error";
const CODE_SENT_ID = "login-code-sent";

/** `oauthError` is a failed Google sign-in from the redirect; it's shown until the user tries again. */
export function LoginForm({ google, oauthError }: { google: boolean; oauthError?: string }) {
  const t = useTranslations("login");
  const tErrors = useTranslations("errors");
  const send = safeAction(loginAction, tErrors("network"));
  // Pass the typed address along: a request that fails outright returns the previous state, which
  // then still has it (the form resets its fields after every submission).
  const [state, action] = useActionState<LoginState, FormData>(
    (prev, data) => send({ ...prev, email: String(data.get("email") ?? "") }, data),
    INITIAL,
  );
  return (
    <>
      {oauthError && state === INITIAL && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {oauthError}
        </p>
      )}
      {google && (
        <>
          <a href="/api/auth/google" className={`${buttonClass("secondary")} w-full`}>
            {t("google")}
          </a>
          <div className="my-4 flex items-center gap-3 text-xs text-stone-400">
            <span className="h-px flex-1 bg-stone-200" />
            {t("or")}
            <span className="h-px flex-1 bg-stone-200" />
          </div>
        </>
      )}
      <form action={action} className="space-y-3">
        <label htmlFor="login-email" className="sr-only">
          {t("emailLabel")}
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          defaultValue={state.email}
          readOnly={state.step === "code"}
          aria-describedby={state.step === "email" && state.error ? ERROR_ID : undefined}
          className={`${inputClass} read-only:bg-stone-100`}
        />
        {state.step === "code" && (
          <>
            <p id={CODE_SENT_ID} role="status" className="text-sm text-stone-600">
              {t(state.resent ? "codeResent" : "codeSent", { email: state.email ?? "" })}
            </p>
            <label htmlFor="login-code" className="sr-only">
              {t("codeLabel")}
            </label>
            <input
              id="login-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              placeholder="123456"
              aria-describedby={state.error ? `${CODE_SENT_ID} ${ERROR_ID}` : CODE_SENT_ID}
              className={`${inputClass} text-center font-mono text-lg tracking-[0.5em]`}
            />
          </>
        )}
        {state.error && (
          <p id={ERROR_ID} role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        )}
        <LoginButtons step={state.step} />
      </form>
    </>
  );
}

const linkButtonClass = "text-sm text-stone-500 enabled:hover:text-stone-800 disabled:cursor-not-allowed";

/** The clicked button shows the progress, and none can be pressed again until the request is done. */
function LoginButtons({ step }: { step: LoginState["step"] }) {
  const t = useTranslations("login");
  const { pending, data } = useFormStatus();
  // "send" (resend), "change", or null for the main button.
  const intent = pending ? data?.get("intent") : null;
  const label = step === "email" ? t("sendCode") : t("signIn");
  return (
    <div className="flex flex-col gap-2">
      <SubmitButton pendingText={step === "email" ? t("sending") : intent ? label : t("verifying")}>{label}</SubmitButton>
      {step === "code" && (
        <div className="flex justify-center gap-4">
          <button name="intent" value="send" disabled={pending} className={linkButtonClass} formNoValidate>
            {intent === "send" ? t("sending") : t("resend")}
          </button>
          <button name="intent" value="change" disabled={pending} className={linkButtonClass} formNoValidate>
            {t("changeEmail")}
          </button>
        </div>
      )}
    </div>
  );
}
