"use client";

import { createContext, startTransition, useActionState, useContext, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action";
import { buttonClass } from "./ui";

export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  confirm,
}: {
  children: ReactNode;
  pendingText?: string;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
}) {
  const formStatus = useFormStatus();
  // Inside ActionForm the submission doesn't go through <form action>, so read its pending state.
  const pending = useContext(ActionPendingContext) ?? formStatus.pending;
  return (
    <button
      type="submit"
      disabled={pending}
      className={buttonClass(variant)}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}

const ActionPendingContext = createContext<boolean | null>(null);

/**
 * A form bound to a server action that shows the returned error/success message.
 * Submits via onSubmit rather than <form action> because React resets a form's fields
 * after an action submission, which would wipe the user's input when we return an error.
 */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (state: ActionState, data: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        // Include the clicked button's name/value (e.g. amount buttons).
        const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(data));
      }}
    >
      <ActionPendingContext.Provider value={pending}>{children}</ActionPendingContext.Provider>
      {state?.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
      {state?.ok && <p className="mt-2 text-sm text-emerald-700">{state.ok}</p>}
    </form>
  );
}
