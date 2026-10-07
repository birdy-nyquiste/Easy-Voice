"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/agents", label: "Agents" },
  { href: "/voices", label: "Voices" },
  { href: "/numbers", label: "Numbers" },
  { href: "/calls", label: "Calls" },
  { href: "/billing", label: "Billing" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:px-3">
      {LINKS.map((l) => {
        const active = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${active ? "bg-stone-100 font-medium text-stone-900" : "text-stone-600 hover:bg-stone-50"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
