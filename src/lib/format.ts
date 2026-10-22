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

/** Normalize a US number typed by a user to E.164, or null if invalid. */
export function toE164US(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
