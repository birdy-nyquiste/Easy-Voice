const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `s` is a UUID. Ids from URLs, forms and webhooks are checked before they reach a uuid
 * column, where Postgres rejects a malformed one with an error instead of matching nothing.
 */
export function isUuid(s: string): boolean {
  return UUID.test(s);
}
