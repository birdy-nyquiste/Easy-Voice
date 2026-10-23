import { BCP47, type Locale } from "@/i18n/locales";

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (!f) numberFormats.set(key, (f = new Intl.NumberFormat(BCP47[locale], options)));
  return f;
}

/**
 * US dollars in the interface language: 1050 → "$10.50" (en, ja), "US$10.50" (zh), "10,50 US$" (vi), "USD 10.50" (es,
 * where a bare "$" would read as pesos). `whole` drops the cents; `signed` adds "+" to credits.
 */
export function formatCents(cents: number, locale: Locale, { whole = false, signed = false } = {}): string {
  return numberFormat(locale, {
    style: "currency",
    currency: "USD",
    ...(whole && { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
    ...(signed && { signDisplay: "exceptZero" }),
  }).format(cents / 100);
}

/**
 * 500000 → "500,000" in the interface language. For numbers in page messages: next-intl formats
 * `{n, number}` with the bare locale code, which for Spanish means Spain ("500.000") rather than
 * the Latin American Spanish used everywhere else.
 */
export function formatNumber(n: number, locale: Locale): string {
  return numberFormat(locale, { maximumFractionDigits: 2 }).format(n);
}

/** 4613734 → "4.4 MB", with the interface language's decimal separator */
export function formatMegabytes(bytes: number, locale: Locale): string {
  return `${numberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

/** Megabytes, rounded like formatMegabytes, for a `{size, number} MB` argument in a message. */
export function toMegabytes(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(1));
}

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The zone name if it is a valid IANA time zone, else null. */
export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * A moment in the viewer's time zone: "Oct 21, 3:05 PM", with the year when it isn't this year.
 * Without the viewer's zone (their browser hasn't reported it yet) it is shown in UTC and labelled,
 * so it is never silently off. Pass `time: false` for things that are really dates (renewals).
 */
export function formatDateTime(
  d: Date | string | null | undefined,
  locale: Locale,
  timeZone: string | null,
  { time = true } = {},
): string {
  if (!d) return "—";
  const date = new Date(d);
  const zone = timeZone ?? "UTC";
  const year = (x: Date) => x.toLocaleString("en-US", { year: "numeric", timeZone: zone });
  return date.toLocaleString(BCP47[locale], {
    month: "short",
    day: "numeric",
    ...(year(date) !== year(new Date()) && { year: "numeric" }),
    ...(time && { hour: "numeric", minute: "2-digit", ...(!timeZone && { timeZoneName: "short" }) }),
    timeZone: zone,
  });
}

/** A date without the time of day, in the viewer's time zone. */
export function formatDate(d: Date | string | null | undefined, locale: Locale, timeZone: string | null): string {
  return formatDateTime(d, locale, timeZone, { time: false });
}

/** A call's other party: their number, or `unknown` for callers without caller ID (stored as "unknown", "anonymous"…). */
export function formatCallerNumber(n: string, unknown: string): string {
  return /^\+\d/.test(n) ? formatPhone(n) : unknown;
}

/**
 * +1 area codes outside the 50 states and DC: Canada, the Caribbean and Atlantic countries, and the US
 * territories (which Telnyx treats as countries of their own). Calls there cost more than the flat price.
 */
const NON_US_AREA_CODES = new Set([
  // Canada
  "204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354", "365", "367", "368", "382", "387",
  "403", "416", "418", "428", "431", "437", "438", "450", "468", "474", "506", "514", "519", "548", "579", "581",
  "584", "587", "604", "613", "639", "647", "672", "683", "705", "709", "742", "753", "778", "780", "782", "807",
  "819", "825", "867", "873", "879", "902", "905", "942",
  // Caribbean and Atlantic countries
  "242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758", "767", "784", "809",
  "829", "849", "868", "869", "876",
  // US territories
  "340", "670", "671", "684", "787", "939",
]);

/** US toll-free area codes: fine to call (no extra cost), but not numbers we sell. */
const TOLL_FREE_AREA_CODES = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * Whether an E.164 number is an ordinary US number: a real area code and exchange, not premium-rate,
 * one of the common special-use codes, or another country in the +1 plan. Toll-free numbers count only
 * with `tollFree` (calls to them are fine; we don't sell them). Rarely used non-geographic codes may
 * still pass: the outbound profile's US-only setting is the safeguard (README).
 */
export function isUsNumber(e164: string, { tollFree = false } = {}): boolean {
  const m = /^\+1([2-9]\d\d)([2-9]\d\d)\d{4}$/.exec(e164);
  if (!m) return false;
  const [, area, exchange] = m;
  // Special-use area codes repeat their last two digits (800, 888, 900, 911…); X9X and 88X are reserved;
  // 456 is inbound international and 710 the US government.
  const special = area[1] === area[2] || area[1] === "9" || area.startsWith("88") || area === "456" || area === "710";
  if ((special && !(tollFree && TOLL_FREE_AREA_CODES.has(area))) || NON_US_AREA_CODES.has(area)) return false;
  // N11 service codes and 976 premium lines.
  return !exchange.endsWith("11") && exchange !== "976";
}

/** Normalize a US number typed by a user to call it, to E.164, or null if it isn't one we call (see isUsNumber). */
export function toE164US(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  return e164 && isUsNumber(e164, { tollFree: true }) ? e164 : null;
}
