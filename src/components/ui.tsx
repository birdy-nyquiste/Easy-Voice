import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
  back,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Link to the list a detail page came from, e.g. { href: "/calls", label: "All calls" }. */
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {back && (
          <Link
            href={back.href}
            className="group -ml-1 mb-2 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-sm text-stone-500 transition-colors hover:text-stone-900"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="h-4 w-4 transition-transform group-hover:-translate-x-0.5">
              <path fillRule="evenodd" d="M12.8 4.2a.75.75 0 0 1 0 1.06L8.06 10l4.74 4.74a.75.75 0 1 1-1.06 1.06l-5.27-5.27a.75.75 0 0 1 0-1.06l5.27-5.27a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
            </svg>
            {back.label}
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-stone-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-stone-200 bg-white p-5 shadow-sm ${className}`}>{children}</div>;
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-semibold text-stone-700">{children}</h2>;
}

const tones = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  gray: "bg-stone-100 text-stone-600 ring-stone-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, keyof typeof tones> = {
    active: "green",
    ready: "green",
    completed: "green",
    succeeded: "green",
    answered: "blue",
    initiated: "blue",
    pending: "amber",
    processing: "amber",
    syncing: "amber",
    failed: "red",
    rejected: "red",
    released: "gray",
  };
  return <Badge tone={tone[status] ?? "gray"}>{status}</Badge>;
}

const btn = {
  primary: "bg-stone-900 text-white hover:bg-stone-700 disabled:bg-stone-400",
  secondary: "bg-white text-stone-900 ring-1 ring-inset ring-stone-300 hover:bg-stone-50 disabled:text-stone-400",
  danger: "bg-white text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:text-red-300",
};

export function buttonClass(variant: keyof typeof btn = "primary") {
  return `inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${btn[variant]}`;
}

export function ButtonLink({ variant = "primary", ...props }: ComponentProps<typeof Link> & { variant?: keyof typeof btn }) {
  return <Link {...props} className={buttonClass(variant)} />;
}

export const inputClass =
  "block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-stone-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500">{children}</div>;
}

export function Notice({ tone = "amber", children }: { tone?: "amber" | "red" | "green" | "blue"; children: ReactNode }) {
  const cls = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-800",
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    blue: "border-sky-200 bg-sky-50 text-sky-800",
  }[tone];
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

/** Whether `path` is `href` or a page under it. */
export function isActivePath(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/** Underlined tab links; the active one is marked. `scroll={false}` keeps the page in place when switching. */
export function Tabs({ tabs }: { tabs: { href: string; label: ReactNode; active: boolean }[] }) {
  return (
    <nav className="flex gap-1 border-b border-stone-200">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          scroll={false}
          aria-current={t.active ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${t.active ? "border-stone-900 font-medium text-stone-900" : "border-transparent text-stone-500 hover:text-stone-900"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
