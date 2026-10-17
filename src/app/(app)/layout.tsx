import { cookies } from "next/headers";
import { requireUser } from "@/server/auth";
import { formatCents } from "@/lib/format";
import { config } from "@/lib/config";
import { countUnreadMessages } from "@/server/messages";
import { SIDEBAR_COOKIE } from "@/lib/ui-prefs";
import { Sidebar } from "./sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await countUnreadMessages(user.id);
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
  return (
    <div className="min-h-screen md:flex">
      <Sidebar
        account={{ email: user.email, balance: formatCents(user.balanceCents), lowBalance: user.balanceCents <= 0 }}
        unread={unread}
        initialCollapsed={collapsed}
      />
      <main className="mx-auto w-full min-w-0 max-w-5xl flex-1 px-4 py-8 md:px-8">
        {config.telnyx.mode === "mock" && (
          <div className="mb-6 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-800">
            Mock mode: phone numbers, voices, calls and texts are simulated. Set <code>TELNYX_MODE=live</code> to use Telnyx.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
