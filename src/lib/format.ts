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

export function formatDateTime(d: Date | string | null | undefined, locale: Locale): string {
  if (!d) return "—";
  return new Date(d).toLocaleString(BCP47[locale], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Normalize a US number typed by a user to E.164, or null if invalid. */
export function toE164US(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
