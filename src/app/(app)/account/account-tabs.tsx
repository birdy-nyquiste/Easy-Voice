"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "@/components/ui";

const TABS = [
  { href: "/account/billing", label: "Billing" },
  { href: "/account/api-keys", label: "API keys" },
];

export function AccountTabs() {
  const path = usePathname();
  return <Tabs tabs={TABS.map((t) => ({ ...t, active: path === t.href || path.startsWith(`${t.href}/`) }))} />;
}
