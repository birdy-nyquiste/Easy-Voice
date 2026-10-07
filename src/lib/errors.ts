/** An error whose message is safe and meant to be shown to the user. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function userMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof UserError ? err.message : fallback;
}
