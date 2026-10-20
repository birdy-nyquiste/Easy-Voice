"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { isActivePath } from "@/components/ui";
import { SIDEBAR_COOKIE } from "@/lib/ui-prefs";
import { logoutAction } from "../login/actions";

export interface Account {
  email: string;
  /** Formatted, e.g. "$38.69". */
  balance: string;
  lowBalance: boolean;
}

const LINKS: { href: string; label: "overview" | "agents" | "voices" | "numbers" | "calls" | "messages"; icon: ReactNode }[] = [
  { href: "/dashboard", label: "overview", icon: <path d="M3.5 9.5 10 4l6.5 5.5V16a1 1 0 0 1-1 1H12v-4.5H8V17H4.5a1 1 0 0 1-1-1V9.5Z" /> },
  {
    href: "/agents",
    label: "agents",
    icon: (
      <>
        <rect x="4" y="6.5" width="12" height="9.5" rx="3" />
        <path d="M10 3.5v3M8 11h.01M12 11h.01" />
      </>
    ),
  },
  { href: "/voices", label: "voices", icon: <path d="M4 8.5v3M7 6v8M10 4v12M13 6.5v7M16 8.5v3" /> },
  { href: "/numbers", label: "numbers", icon: <path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5h12.5" /> },
  {
    href: "/calls",
    label: "calls",
    icon: (
      <path d="M4.5 3.5h2.1a1 1 0 0 1 .97.76l.62 2.5a1 1 0 0 1-.37 1.04l-1.17.88a9 9 0 0 0 4.67 4.67l.88-1.17a1 1 0 0 1 1.04-.37l2.5.62a1 1 0 0 1 .76.97v2.1a1 1 0 0 1-1 1H14C8.2 16.5 3.5 11.8 3.5 6V4.5a1 1 0 0 1 1-1Z" />
    ),
  },
  {
    href: "/messages",
    label: "messages",
    icon: <path d="M5 4h10a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H9.5L6 16.5v-3H5A1.5 1.5 0 0 1 3.5 12V5.5A1.5 1.5 0 0 1 5 4Z" />,
  },
];

const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-stone-300";

function Icon({ children, className = "h-5 w-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

/** Visual label for an icon in the collapsed rail; the link's own text is what screen readers hear. */
function Tooltip({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-full top-1/2 z-30 ml-3 hidden -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-md bg-stone-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-md transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 md:block motion-reduce:transition-none"
    >
      {children}
    </span>
  );
}

export function Sidebar({ account, unread, initialCollapsed }: { account: Account; unread: number; initialCollapsed: boolean }) {
  const t = useTranslations("nav");
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  }

  // On phones the sidebar is a top bar and never collapses, so every collapsed style is md: only.
  const labelClass = `whitespace-nowrap transition-opacity duration-150 motion-reduce:transition-none ${collapsed ? "md:opacity-0" : "opacity-100 delay-75"}`;

  return (
    <aside
      className={`relative border-b border-stone-200 bg-white md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:flex-col md:border-b-0 md:border-r md:transition-[width] md:duration-200 md:ease-out motion-reduce:transition-none ${collapsed ? "md:w-16" : "md:w-56"}`}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? t("expand") : t("collapse")}
        title={collapsed ? t("expand") : t("collapse")}
        className={`absolute -right-3 top-6 z-20 hidden h-6 w-6 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-sm transition hover:border-stone-300 hover:text-stone-900 md:flex ${focusRing}`}
      >
        <Icon className={`h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none ${collapsed ? "rotate-180" : ""}`}>
          <path d="M12 5.5 7.5 10l4.5 4.5" />
        </Icon>
      </button>

      <div className={`flex items-center justify-between gap-3 px-4 py-4 md:block ${collapsed ? "md:px-3" : ""}`}>
        <Link href="/dashboard" className="flex items-center gap-2 overflow-hidden font-semibold">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-sm text-white md:ml-1.5">◉</span>
          <span className={labelClass}>Easy Voice</span>
        </Link>
        <div className="md:hidden">
          <AccountPopover account={account} placement="below" />
        </div>
      </div>

      <nav className={`flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:px-3 ${collapsed ? "md:px-2" : ""}`}>
        {LINKS.map((l) => {
          const active = isActivePath(path, l.href);
          const showUnread = l.href === "/messages" && unread > 0;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`group relative flex shrink-0 items-center rounded-lg px-3 py-2 text-sm transition-colors ${focusRing} ${active ? "bg-stone-100 font-medium text-stone-900" : "text-stone-600 hover:bg-stone-50 hover:text-stone-900"}`}
            >
              <span className="flex items-center gap-3 overflow-hidden">
                <span className="relative hidden md:block">
                  <Icon>{l.icon}</Icon>
                  {showUnread && collapsed && (
                    <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-sky-600 ring-2 ring-white" />
                  )}
                </span>
                <span className={labelClass}>{t(l.label)}</span>
                {showUnread && (
                  // Hidden from view in the rail (the dot shows instead) but still read out.
                  <span className={`rounded-full bg-sky-600 px-1.5 py-0.5 text-xs font-medium text-white ${collapsed ? "md:sr-only" : ""}`}>
                    {unread}
                    <span className="sr-only">{t("unreadSr")}</span>
                  </span>
                )}
              </span>
              {collapsed && (
                <Tooltip>
                  {t(l.label)}
                  {showUnread && t("unreadTooltip", { count: unread })}
                </Tooltip>
              )}
            </Link>
          );
        })}
      </nav>

      <div className={`mt-auto hidden p-3 md:block ${collapsed ? "md:px-2" : ""}`}>
        {collapsed ? <AccountPopover account={account} placement="side" /> : <AccountCard account={account} />}
      </div>
    </aside>
  );
}

/**
 * Open/close state for an account menu: closes on navigation, Escape and outside clicks, moves
 * focus into the menu when it opens, and back to the trigger when it closes from inside.
 */
function useMenu(panel: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const path = usePathname();
  const [openedAt, setOpenedAt] = useState(path);
  if (open && path !== openedAt) setOpen(false);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
    const close = (refocus: boolean) => {
      // The panel turns inert when closed; without this, focus inside it would fall back to <body>.
      if (refocus || root.current?.contains(document.activeElement)) trigger.current?.focus();
      setOpen(false);
    };
    const onPointer = (e: PointerEvent) => !root.current?.contains(e.target as Node) && close(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, panel]);

  const toggle = () => {
    setOpenedAt(path);
    setOpen((o) => !o);
  };
  return { open, toggle, root, trigger, onAccount: isActivePath(path, "/account") };
}

function Avatar({ account }: { account: Account }) {
  return (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-900 text-sm font-medium text-white">
      {account.email.charAt(0).toUpperCase()}
      {account.lowBalance && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />}
    </span>
  );
}

function AccountActions({ account }: { account: Account }) {
  const t = useTranslations("nav");
  const path = usePathname();
  const onAccount = isActivePath(path, "/account");
  const rowClass = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${focusRing}`;
  const plain = "text-stone-700 hover:bg-stone-100 hover:text-stone-900";
  return (
    <div className="space-y-0.5">
      <Link href="/account/billing" className={`${rowClass} ${account.lowBalance ? "bg-red-50 text-red-700 hover:bg-red-100" : plain}`}>
        <Icon className="h-4 w-4">
          <rect x="3" y="5.5" width="14" height="10" rx="2" />
          <path d="M3 9h14M6.5 12.5h2" />
        </Icon>
        <span className="flex-1">{t("balance")}</span>
        <span className="font-semibold tabular-nums">{account.balance}</span>
      </Link>
      <Link
        href="/account"
        aria-current={onAccount ? "page" : undefined}
        className={`${rowClass} ${onAccount ? "bg-stone-200/70 text-stone-900" : plain}`}
      >
        <Icon className="h-4 w-4">
          <circle cx="10" cy="7" r="3" />
          <path d="M4.5 16.5a5.5 5.5 0 0 1 11 0" />
        </Icon>
        {t("account")}
      </Link>
      {/* No visible label: the globe stands in for it; the select is named for screen readers. */}
      <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-stone-700">
        <Icon className="h-4 w-4">
          <circle cx="10" cy="10" r="6.5" />
          <path d="M3.5 10h13M10 3.5c1.8 1.8 2.6 4 2.6 6.5s-.8 4.7-2.6 6.5c-1.8-1.8-2.6-4-2.6-6.5s.8-4.7 2.6-6.5Z" />
        </Icon>
        <LocaleSwitcher fill />
      </div>
      <form action={logoutAction}>
        <button type="submit" className={`${rowClass} text-stone-700 hover:bg-red-50 hover:text-red-700`}>
          <Icon className="h-4 w-4">
            <path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8M12 13.5 15.5 10 12 6.5M15.5 10H8.5" />
          </Icon>
          {t("signOut")}
        </button>
      </form>
    </div>
  );
}

/** Expanded sidebar: shows the email; opening slides the balance and actions up above it. */
function AccountCard({ account }: { account: Account }) {
  const t = useTranslations("nav");
  const panel = useRef<HTMLDivElement>(null);
  const { open, toggle, root, trigger, onAccount } = useMenu(panel);
  const highlighted = open || onAccount;
  return (
    <div
      ref={root}
      className={`overflow-hidden rounded-xl border transition-colors ${highlighted ? "border-stone-200 bg-stone-50" : "border-transparent hover:bg-stone-50"}`}
    >
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          <div
            ref={panel}
            inert={!open}
            className={`border-b border-stone-200 p-1.5 transition-opacity duration-200 motion-reduce:transition-none ${open ? "opacity-100" : "opacity-0"}`}
          >
            <AccountActions account={account} />
          </div>
        </div>
      </div>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={t(account.lowBalance ? "accountMenuEmpty" : "accountMenu", { email: account.email })}
        className={`flex w-full items-center gap-2.5 rounded-xl p-2 text-left ${focusRing}`}
      >
        <Avatar account={account} />
        <span className="min-w-0 flex-1 truncate text-sm text-stone-700" title={account.email}>
          {account.email}
        </span>
        <Icon className={`h-4 w-4 text-stone-400 transition-transform duration-200 motion-reduce:transition-none ${open ? "" : "rotate-180"}`}>
          <path d="M6 12.5 10 8.5l4 4" />
        </Icon>
      </button>
    </div>
  );
}

/** Collapsed rail (opens to the side) and phones (opens below): an avatar with a floating menu. */
function AccountPopover({ account, placement }: { account: Account; placement: "side" | "below" }) {
  const t = useTranslations("nav");
  const panel = useRef<HTMLDivElement>(null);
  const { open, toggle, root, trigger, onAccount } = useMenu(panel);
  const highlighted = open || onAccount;
  const side = placement === "side";
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={t(account.lowBalance ? "accountMenuEmpty" : "accountMenu", { email: account.email })}
        title={side && !open ? account.email : undefined}
        className={`flex items-center justify-center rounded-full transition ${focusRing} ${side ? "mx-auto p-1 hover:bg-stone-100" : ""} ${highlighted ? "ring-2 ring-stone-300" : ""}`}
      >
        <Avatar account={account} />
      </button>
      <div
        ref={panel}
        inert={!open}
        className={`absolute z-40 w-60 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg transition duration-150 ease-out motion-reduce:transition-none ${
          side ? "bottom-0 left-full ml-3 origin-bottom-left" : "right-0 top-full mt-2 origin-top-right"
        } ${open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"}`}
      >
        <p className="mb-1.5 truncate border-b border-stone-100 px-2.5 pb-2.5 pt-1 text-sm text-stone-500" title={account.email}>
          {account.email}
        </p>
        <AccountActions account={account} />
      </div>
    </div>
  );
}
