import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui";
import { AccountTabs } from "./account-tabs";

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("account");
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <AccountTabs />
      {children}
    </div>
  );
}
