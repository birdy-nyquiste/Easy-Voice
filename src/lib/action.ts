import { userMessage } from "./errors";

export type ActionState = { error?: string; ok?: string } | undefined;

/** Run a server action body, turning thrown UserErrors into form state. */
export async function attempt(fn: () => Promise<string | void>): Promise<ActionState> {
  try {
    const ok = await fn();
    return { ok: ok || undefined };
  } catch (err) {
    // Let Next.js redirect()/notFound() propagate.
    if (err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_")) {
      throw err;
    }
    if (!(err instanceof Error && err.name === "UserError")) console.error(err);
    return { error: userMessage(err) };
  }
}
