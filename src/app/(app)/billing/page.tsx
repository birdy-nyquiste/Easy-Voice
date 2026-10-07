import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardTitle, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatDateTime } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { listLedger, listPayments } from "@/server/billing/payments";
import { devCreditAction, topupAction } from "./actions";

const AMOUNTS = [10, 25, 50, 100];

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ topup?: string }> }) {
  const user = await requireUser();
  const { topup } = await searchParams;
  const [ledger, payments] = await Promise.all([listLedger(user.id), listPayments(user.id)]);
  const p = config.pricing;

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Prepaid credit. Usage is deducted from your balance." />
      {topup === "success" && <Notice tone="green">Payment received. Your balance will update in a moment if it hasn&apos;t already.</Notice>}
      {topup === "cancelled" && <Notice>Checkout was cancelled. You weren&apos;t charged.</Notice>}
      {user.balanceCents <= 0 && (
        <Notice tone="red">
          Your balance is empty. Incoming calls are declined and outgoing calls are blocked until you top up.
          {user.balanceCents < 0 && ` Numbers are released after ${config.policy.negativeBalanceReleaseDays} days with a negative balance.`}
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Balance</CardTitle>
          <p className={`text-3xl font-semibold ${user.balanceCents <= 0 ? "text-red-600" : ""}`}>{formatCents(user.balanceCents)}</p>
          <ActionForm action={topupAction} className="mt-4">
            <div className="flex flex-wrap gap-2">
              {AMOUNTS.map((a, i) => (
                <label key={a} className="cursor-pointer">
                  <input type="radio" name="amount" value={a} defaultChecked={i === 1} className="peer sr-only" />
                  <span className="block rounded-lg px-4 py-2 text-sm font-medium ring-1 ring-stone-300 peer-checked:bg-stone-900 peer-checked:text-white peer-checked:ring-stone-900">
                    ${a}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-3">
              <SubmitButton pendingText="Redirecting to Stripe…">Add credit</SubmitButton>
            </div>
          </ActionForm>
          {config.devCreditEnabled && (
            <ActionForm action={devCreditAction} className="mt-4 rounded-lg border border-dashed border-sky-300 bg-sky-50 p-3">
              <p className="mb-2 text-xs font-medium text-sky-800">Dev only — add credit without paying (hidden in production)</p>
              <div className="flex gap-2">
                {[10, 50].map((a) => (
                  <button key={a} name="amount" value={a} className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-sky-800 ring-1 ring-sky-300 hover:bg-sky-100">
                    +${a}
                  </button>
                ))}
              </div>
            </ActionForm>
          )}
        </Card>
        <Card>
          <CardTitle>Pricing</CardTitle>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt>Calls (in or out)</dt><dd className="font-medium">{formatCents(p.callPerMinuteCents)} / min</dd></div>
            <div className="flex justify-between"><dt>Phone number</dt><dd className="font-medium">{formatCents(p.numberMonthlyCents)} / month</dd></div>
            <div className="flex justify-between"><dt>Voice clone</dt><dd className="font-medium">{formatCents(p.voiceCloneCents)} each</dd></div>
          </dl>
          <p className="mt-4 text-xs text-stone-500">Payments are processed by Stripe. There are no subscriptions — number rental is deducted from your balance every 30 days. Call minutes are rounded up. Unanswered calls are free. Failed purchases are refunded automatically.</p>
        </Card>
      </div>

      <Card className="p-0">
        <div className="px-5 pt-5"><CardTitle>Activity</CardTitle></div>
        {ledger.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-stone-500">No activity yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-stone-100">
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td className="px-5 py-2.5 text-stone-500">{formatDateTime(e.createdAt)}</td>
                  <td className="px-3 py-2.5">{e.description}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${e.amountCents > 0 ? "text-emerald-700" : ""}`}>
                    {e.amountCents > 0 ? "+" : ""}{formatCents(e.amountCents)}
                  </td>
                  <td className="hidden px-5 py-2.5 text-right tabular-nums text-stone-500 sm:table-cell">{formatCents(e.balanceAfterCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {payments.some((x) => x.status !== "succeeded") && (
        <Card>
          <CardTitle>Payments</CardTitle>
          <ul className="divide-y divide-stone-100 text-sm">
            {payments.map((x) => (
              <li key={x.id} className="flex items-center justify-between py-2">
                <span>{formatDateTime(x.createdAt)} · {formatCents(x.amountCents)}</span>
                <span className="flex items-center gap-2">
                  {x.failureReason && <span className="text-stone-500">{x.failureReason}</span>}
                  <StatusBadge status={x.status} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
