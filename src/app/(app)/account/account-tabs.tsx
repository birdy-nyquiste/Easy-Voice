"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Tabs, isActivePath } from "@/components/ui";

const TABS = [
  { href: "/account/billing", label: "billing" },
  { href: "/account/api-keys", label: "apiKeys" },
] as const;

export function AccountTabs() {
  const t = useTranslations("account");
  const path = usePathname();
  return <Tabs tabs={TABS.map((tab) => ({ href: tab.href, label: t(tab.label), active: isActivePath(path, tab.href) }))} />;
}
