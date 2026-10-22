import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/db/schema";

const jar = { cookies: new Map<string, string>() };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.cookies.has(name) ? { value: jar.cookies.get(name) } : undefined),
    set: (name: string, value: string) => jar.cookies.set(name, value),
  }),
  headers: async () => new Headers({ "accept-language": "ja-JP,ja;q=0.9" }),
}));
const signedIn: { user: Partial<User> | null } = { user: null };
vi.mock("@/server/auth", () => ({ getCurrentUser: async () => signedIn.user }));

const { requestLocale } = await import("@/i18n/request");
const { syncLocaleAtSignIn } = await import("@/server/locale");

beforeEach(() => {
  jar.cookies.clear();
  signedIn.user = null;
});

describe("a saved language this build doesn't have", () => {
  // e.g. saved by a preview build that has more languages, on the shared database
  it("is ignored when choosing the interface language", async () => {
    signedIn.user = { locale: "xx" as User["locale"] };
    expect(await requestLocale()).toBe("ja"); // falls through to the browser's languages
    signedIn.user = { locale: "zh" };
    expect(await requestLocale()).toBe("zh");
  });

  it("isn't copied into this browser's language cookie at sign-in", async () => {
    await syncLocaleAtSignIn({ id: "u1", locale: "xx" } as unknown as User);
    expect(jar.cookies.has("ev_locale")).toBe(false);
    await syncLocaleAtSignIn({ id: "u1", locale: "es" } as unknown as User);
    expect(jar.cookies.get("ev_locale")).toBe("es");
  });
});
