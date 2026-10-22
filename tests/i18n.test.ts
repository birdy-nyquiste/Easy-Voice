import { readFileSync } from "node:fs";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { LOCALES, localeFromAcceptLanguage } from "@/i18n/locales";
import { MESSAGES } from "@/i18n/messages";
import { errorText, UserError } from "@/lib/errors";
import { formatCents, formatMegabytes } from "@/lib/format";
import { showStored, stored, storedColumns, storedFromError } from "@/lib/stored-text";

/** Intl puts a no-break space between "USD" and the amount. */
const plain = (s: string | null) => s?.replace(/\u00a0/g, " ");

type Tree = { [key: string]: string | Tree };

/** "nav.balance" → message, for every leaf. */
function flatten(tree: Tree, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).flatMap(([k, v]) =>
      typeof v === "string" ? [[`${prefix}${k}`, v]] : Object.entries(flatten(v, `${prefix}${k}.`)),
    ),
  );
}

const flat = Object.fromEntries(LOCALES.map((l) => [l, flatten(MESSAGES[l])]));
const en = flat.en;
const translations = LOCALES.filter((l) => l !== "en");

/** Argument names and rich-text tags a message uses, ignoring quoted (literal) braces. */
function slots(message: string): string[] {
  const unquoted = message.replace(/'[{}][^']*'/g, "");
  const args = [...unquoted.matchAll(/\{\s*(\w+)/g)].map((m) => `{${m[1]}}`);
  const tags = [...unquoted.matchAll(/<(\w+)>/g)].map((m) => `<${m[1]}>`);
  return [...new Set([...args, ...tags])].sort();
}

describe("messages", () => {
  it.each(translations)("has the same keys in %s as in English", (locale) => {
    expect(Object.keys(flat[locale]).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(translations)("keeps every placeholder and tag in the %s translation", (locale) => {
    const mismatched = Object.keys(en).filter((k) => slots(en[k]).join() !== slots(flat[locale][k] ?? "").join());
    expect(mismatched).toEqual([]);
  });

  it("formats every message in every language", () => {
    for (const locale of LOCALES) {
      const errors: string[] = [];
      const t = createTranslator({ locale, messages: MESSAGES[locale], onError: (e) => errors.push(e.message) });
      for (const [key, message] of Object.entries(flat[locale])) {
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

  it("picks Vietnamese for vi and vi-VN", () => {
    expect(localeFromAcceptLanguage("vi-VN,vi;q=0.9,en;q=0.8")).toBe("vi");
    expect(localeFromAcceptLanguage("vi")).toBe("vi");
  });

  it("picks Spanish and Japanese for any regional variant", () => {
    expect(localeFromAcceptLanguage("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(localeFromAcceptLanguage("es")).toBe("es");
    expect(localeFromAcceptLanguage("ja-JP")).toBe("ja");
    expect(localeFromAcceptLanguage("ja,en-US;q=0.7")).toBe("ja");
    expect(localeFromAcceptLanguage("en-US,ja;q=0.9")).toBe("en");
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

  it("formats amounts and sizes in the viewer's language, including rows that stored '$25.00'", () => {
    expect(storedColumns(stored("ledgerTopup", { amount: 25 })).text).toBe("Top-up $25.00");
    expect(plain(showStored("es", "Top-up $25.00", { key: "stored.ledgerTopup", values: { amount: 25 } }))).toBe("Recarga de USD 25.00");
    expect(plain(showStored("zh", "Top-up $25.00", { key: "stored.ledgerTopup", values: { amount: "$25.00" } }))).toBe("充值 US$25.00");
    expect(new UserError("audioTooLarge", { size: 4.5 }).message).toBe("Audio sample must be under 4.5 MB.");
    expect(errorText("es", "audioTooLarge", { size: 4.5 })).toBe("La muestra de audio debe pesar menos de 4.5 MB.");
  });

  it("formats money in the interface language", () => {
    expect(formatCents(-1050, "en")).toBe("-$10.50");
    expect(plain(formatCents(2500, "es", { whole: true }))).toBe("USD 25");
    expect(formatCents(1000, "ja", { signed: true })).toBe("+$10.00");
    expect(plain(formatCents(1050, "vi"))).toBe("10,50 US$");
    expect(formatMegabytes(4613734, "es")).toBe("4.4 MB");
  });

  it("falls back to the stored English for older rows and unknown keys", () => {
    expect(showStored("zh", "Top-up $25.00", null)).toBe("Top-up $25.00");
    // @ts-expect-error -- a key that no longer exists
    expect(showStored("zh", "Old text", { key: "stored.gone" })).toBe("Old text");
    expect(showStored("zh", null, null)).toBeNull();
  });
});

describe("pre-i18n backfill (drizzle/0013)", () => {
  const sql = readFileSync("drizzle/0013_backfill_stored_messages.sql", "utf8");
  const statements = sql.split("--> statement-breakpoint");
  const samples: Record<string, Record<string, string | number>> = {
    amount: { amount: 1234.5 },
    number: { number: "+14155551000" },
    name: { name: 'My "best" voice' },
    minutes: { minutes: 3 },
    sms: { from: "+12025550123" },
    cause: { cause: "normal_clearing" },
  };

  it("matches the English of every message it backfills", () => {
    const checked: string[] = [];
    for (const statement of statements) {
      const pattern = /WHERE[^~]*~ '([^']+)'/.exec(statement)?.[1];
      if (!pattern) continue;
      for (const [, key] of statement.matchAll(/'stored\.(\w+)'/g)) {
        for (const values of [...Object.values(samples), { from: "+12025550123", parts: 1 }, { from: "+12025550123", parts: 2 }]) {
          // @ts-expect-error -- keys come from the SQL at runtime
          const text = storedColumns(stored(key, values)).text;
          if (new RegExp(pattern).test(text)) checked.push(key);
        }
      }
    }
    const fixed = [...sql.matchAll(/\('((?:[^']|'')+)', 'stored\.(\w+)'\)/g)];
    for (const [, text, key] of fixed) {
      // @ts-expect-error -- keys come from the SQL at runtime
      expect(storedColumns(stored(key)).text, key).toBe(text.replace(/''/g, "'"));
      checked.push(key);
    }
    // Knowledge-base lines and these outcomes came after i18n, so no rows predate their messages.
    const addedLater = ["outcomeStatusLost"];
    const backfilled = Object.keys(MESSAGES.en.stored).filter(
      (k) => /^(ledger|outcome)/.test(k) && !k.startsWith("ledgerKnowledge") && !addedLater.includes(k),
    );
    expect(new Set(checked)).toEqual(new Set(backfilled));
  });
});
