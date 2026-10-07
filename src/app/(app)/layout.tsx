import Link from "next/link";
import { requireUser } from "@/server/auth";
import { formatCents } from "@/lib/format";
import { config } from "@/lib/config";
import { logoutAction } from "../login/actions";
import { NavLinks } from "./nav-links";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const low = user.balanceCents <= 0;
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-stone-200 bg-white md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-4 md:block">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-stone-900 text-sm text-white">◉</span>
            Easy Voice
          </Link>
          <Link
            href="/billing"
            className={`rounded-lg px-2 py-1 text-sm font-medium md:mt-4 md:block md:px-3 md:py-2 ${low ? "bg-red-50 text-red-700" : "bg-stone-100 text-stone-700"}`}
          >
            <span className="hidden text-xs font-normal text-stone-500 md:block">Balance</span>
            {formatCents(user.balanceCents)}
          </Link>
        </div>
        <NavLinks />
        <div className="flex items-center justify-between gap-3 px-4 pb-3 text-xs text-stone-500 md:absolute md:bottom-0 md:block md:w-full md:py-4">
          <div className="truncate">{user.email}</div>
          <form action={logoutAction}>
            <button className="mt-1 hover:text-stone-900">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8">
        {config.telnyx.mode === "mock" && (
          <div className="mb-6 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-800">
            Mock mode: phone numbers, voices and calls are simulated. Set <code>TELNYX_MODE=live</code> to use Telnyx.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
