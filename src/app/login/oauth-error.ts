/** Error codes the Google sign-in routes put in /login?error=, and their login.* messages. */
const ERRORS = {
  google_disabled: "googleDisabled",
  google_state: "googleState",
  google_email: "googleEmail",
  google_failed: "googleFailed",
} as const;

export function oauthErrorKey(code: string): (typeof ERRORS)[keyof typeof ERRORS] | "failed" {
  // Own keys only: `in` would also match inherited names such as "constructor".
  return Object.hasOwn(ERRORS, code) ? ERRORS[code as keyof typeof ERRORS] : "failed";
}
