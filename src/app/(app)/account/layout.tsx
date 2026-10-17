import { PageHeader } from "@/components/ui";
import { AccountTabs } from "./account-tabs";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <PageHeader title="Account" description="Your balance and payments, and the services you've connected." />
      <AccountTabs />
      {children}
    </div>
  );
}
