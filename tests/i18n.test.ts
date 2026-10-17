import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage } from "@/i18n/locales";
import { MESSAGES } from "@/i18n/messages";
import { UserError } from "@/lib/errors";
import { showStored, stored, storedColumns, storedFromError } from "@/lib/stored-text";

type Tree = { [key: string]: string | Tree };

/** "nav.balance" → message, for every leaf. */
function flatten(tree: Tree, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).flatMap(([k, v]) =>
      typeof v === "string" ? [[`${prefix}${k}`, v]] : Object.entries(flatten(v, `${prefix}${k}.`)),
    ),
  );
}

const en = flatten(MESSAGES.en);
const zh = flatten(MESSAGES.zh);

/** Argument names and rich-text tags a message uses, ignoring quoted (literal) braces. */
function slots(message: string): string[] {
  const unquoted = message.replace(/'[{}][^']*'/g, "");
  const args = [...unquoted.matchAll(/\{\s*(\w+)/g)].map((m) => `{${m[1]}}`);
  const tags = [...unquoted.matchAll(/<(\w+)>/g)].map((m) => `<${m[1]}>`);
  return [...new Set([...args, ...tags])].sort();
}

describe("messages", () => {
  it("has the same keys in Chinese as in English", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps every placeholder and tag in the translation", () => {
    const mismatched = Object.keys(en).filter((k) => slots(en[k]).join() !== slots(zh[k] ?? "").join());
    expect(mismatched).toEqual([]);
  });

  it("formats every message in both languages", () => {
    for (const locale of ["en", "zh"] as const) {
      const errors: string[] = [];
      const t = createTranslator({ locale, messages: MESSAGES[locale], onError: (e) => errors.push(e.message) });
      for (const [key, message] of Object.entries(locale === "en" ? en : zh)) {
        const values: Record<string, string | number | ((chunks: string) => string)> = {};
        for (const slot of slots(message)) {
          const name = slot.slice(1, -1);
          values[name] = slot.startsWith("<") ? (chunks) => chunks : 1;
        }
        // @ts-expect-error -- keys come from the files at runtime
        t.markup(key, values);
      }
      expect(errors, locale).toEqual([]);
    }
  });
});

describe("localeFromAcceptLanguage", () => {
  it("picks Simplified Chinese for zh, zh-CN and zh-Hans", () => {
    expect(localeFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(localeFromAcceptLanguage("zh")).toBe("zh");
    expect(localeFromAcceptLanguage("zh-Hans-CN")).toBe("zh");
  });

  it("follows the q ranking", () => {
    expect(localeFromAcceptLanguage("en-US;q=0.5,zh-CN;q=0.9")).toBe("zh");
    expect(localeFromAcceptLanguage("en-US,zh-CN;q=0.9")).toBe("en");
  });

  it("falls back to English for Traditional Chinese, other languages and no header", () => {
    expect(localeFromAcceptLanguage("zh-TW")).toBe("en");
    expect(localeFromAcceptLanguage("fr-FR,de;q=0.8")).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
  });
});

describe("stored text", () => {
  it("keeps the English text and the message it came from", () => {
    expect(storedColumns(stored("ledgerSms", { from: "+14155550100", parts: 2 }))).toEqual({
      text: "Text from +14155550100 (2 segments)",
      msg: { key: "stored.ledgerSms", values: { from: "+14155550100", parts: 2 } },
    });
    expect(storedColumns("Order rejected: number unavailable")).toEqual({ text: "Order rejected: number unavailable", msg: null });
  });

  it("shows the message in the viewer's language, including user errors", () => {
    const { text, msg } = storedColumns(storedFromError(new UserError("elevenLabsBusy")));
    expect(text).toMatch(/ElevenLabs is busy/);
    expect(showStored("zh", text, msg)).toBe("ElevenLabs 繁忙，或已达到你套餐的上限，请一分钟后再试。");
  });

  it("falls back to the stored English for older rows and unknown keys", () => {
    expect(showStored("zh", "Top-up $25.00", null)).toBe("Top-up $25.00");
    // @ts-expect-error -- a key that no longer exists
    expect(showStored("zh", "Old text", { key: "stored.gone" })).toBe("Old text");
    expect(showStored("zh", null, null)).toBeNull();
  });
});
