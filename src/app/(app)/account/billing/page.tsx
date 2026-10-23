import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardTitle, Notice, StatusBadge } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatDateTime } from "@/lib/format";
import { showStored } from "@/lib/stored-text";
import { requireUser } from "@/server/auth";
import { cancelTopup, listLedger, listPayments, settleReturnedTopup, type ReturnedTopup } from "@/server/billing/payments";
import { listUserNumbers } from "@/server/numbers";
import { NegativeBalanceNotice } from "../../negative-balance-notice";
import { devCreditAction, topupAction } from "./actions";
import { viewerTimeZone } from "@/server/time-zone";

/** Top-up presets in dollars; the ones outside the configured limits aren't offered. */
const PRESETS = [10, 25, 50, 100];
/** Activity rows shown. */
const LEDGER_LIMIT = 100;

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ topup?: string; session_id?: string; payment?: string }>;
}) {
  const user = await requireUser();
  const { topup, session_id: sessionId, payment } = await searchParams;
  let returned: ReturnedTopup | null = null;
  if (topup === "success" && sessionId) {
    returned = await settleReturnedTopup(user.id, sessionId);
    // Load the page again so the balance, here and in the sidebar, includes the credit.
    if (returned === "credited") redirect(`/account/billing?topup=success&session_id=${encodeURIComponent(sessionId)}`);
  }
  if (topup === "cancelled" && payment) await cancelTopup(user.id, payment);
  const [ledger, payments, numbers] = await Promise.all([listLedger(user.id, LEDGER_LIMIT), listPayments(user.id), listUserNumbers(user.id)]);
  const p = config.pricing;
  const amounts = PRESETS.filter((a) => a * 100 >= p.minTopupCents && a * 100 <= p.maxTopupCents);
  if (amounts.length === 0) amounts.push(p.minTopupCents / 100);
  // The webhook usually credits within seconds; until then the balance isn't really empty.
  const awaitingCredit = returned === "pending";
  const [t, locale] = await Promise.all([getTranslations("billing"), getLocale()]);
  const tz = await viewerTimeZone();

  return (
    <div className="space-y-6">
      {awaitingCredit && <AutoRefresh everyMs={3000} />}
      <p className="text-sm text-stone-500">{t("intro")}</p>
      {returned === "succeeded" && <Notice tone="green">{t("paymentCredited")}</Notice>}
      {returned === "processing" && <Notice tone="blue">{t("paymentProcessing")}</Notice>}
      {(awaitingCredit || (topup === "success" && !returned)) && <Notice tone="green">{t("paymentReceived")}</Notice>}
      {topup === "cancelled" && <Notice>{t("checkoutCancelled")}</Notice>}
      {!awaitingCredit && user.balanceCents === 0 && <Notice tone="red">{t("balanceEmpty")}</Notice>}
      {!awaitingCredit && user.balanceCents < 0 && (
        <NegativeBalanceNotice user={user} hasNumber={numbers.some((n) => n.status === "active")} />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>{t("balance")}</CardTitle>
          <p className={`text-3xl font-semibold ${user.balanceCents <= 0 ? "text-red-600" : ""}`}>{formatCents(user.balanceCents, locale)}</p>
          <ActionForm action={topupAction} className="mt-4">
            <fieldset>
              <legend className="sr-only">{t("topupAmount")}</legend>
              <div className="flex flex-wrap gap-2">
                {amounts.map((a, i) => (
                  <label key={a} className="cursor-pointer">
                    <input type="radio" name="amount" value={a} defaultChecked={i === Math.min(1, amounts.length - 1)} className="peer sr-only" />
                    <span className="block rounded-lg px-4 py-2 text-sm font-medium ring-1 ring-stone-300 peer-checked:bg-stone-900 peer-checked:text-white peer-checked:ring-stone-900 peer-focus-visible:ring-2 peer-focus-visible:ring-stone-400 peer-focus-visible:ring-offset-2">
                      {formatCents(a * 100, locale, { whole: Number.isInteger(a) })}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-3">
              <SubmitButton pendingText={t("redirecting")}>{t("addCredit")}</SubmitButton>
            </div>
          </ActionForm>
          {config.devCreditEnabled && (
            <ActionForm action={devCreditAction} className="mt-4 rounded-lg border border-dashed border-sky-300 bg-sky-50 p-3">
              <p className="mb-2 text-xs font-medium text-sky-800">{t("devOnly")}</p>
              <div className="flex gap-2">
                {[10, 50].map((a) => (
                  <button key={a} name="amount" value={a} className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-sky-800 ring-1 ring-sky-300 hover:bg-sky-100">
                    {formatCents(a * 100, locale, { whole: true, signed: true })}
                  </button>
                ))}
              </div>
            </ActionForm>
          )}
        </Card>
        <Card>
          <CardTitle>{t("pricing")}</CardTitle>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt>{t("calls")}</dt><dd className="font-medium">{t("perMin", { price: formatCents(p.callPerMinuteCents, locale) })}</dd></div>
            <div className="flex justify-between"><dt>{t("number")}</dt><dd className="font-medium">{t("perMonth", { price: formatCents(p.numberMonthlyCents, locale) })}</dd></div>
            <div className="flex justify-between"><dt>{t("clone")}</dt><dd className="font-medium">{t("each", { price: formatCents(p.voiceCloneCents, locale) })}</dd></div>
            {config.features.knowledgeBase && (
              <div className="flex justify-between"><dt>{t("knowledgeSource")}</dt><dd className="font-medium">{t("each", { price: formatCents(p.knowledgeSourceCents, locale) })}</dd></div>
            )}
            {config.features.inboundSms && (
              <div className="flex justify-between"><dt>{t("textReceived")}</dt><dd className="font-medium">{t("perSegment", { price: formatCents(p.smsInboundPerPartCents, locale) })}</dd></div>
            )}
          </dl>
          <p className="mt-4 text-xs text-stone-500">{t("terms")}{config.features.inboundSms && t("segmentNote")}</p>
        </Card>
      </div>

      <Card className="overflow-x-auto p-0">
        <div className="px-5 pt-5"><CardTitle>{t("activity")}</CardTitle></div>
        {ledger.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-stone-500">{t("noActivity")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-stone-100 text-left text-xs text-stone-500">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">{t("columnDate")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("columnDescription")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t("columnAmount")}</th>
                <th scope="col" className="hidden px-5 py-2 text-right font-medium sm:table-cell">{t("balance")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td className="px-5 py-2.5 text-stone-500">{formatDateTime(e.createdAt, locale, tz)}</td>
                  <td className="px-3 py-2.5">{showStored(locale, e.description, e.descriptionMsg)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${e.amountCents > 0 ? "text-emerald-700" : ""}`}>
                    {formatCents(e.amountCents, locale, { signed: true })}
                  </td>
                  <td className="hidden px-5 py-2.5 text-right tabular-nums text-stone-500 sm:table-cell">{formatCents(e.balanceAfterCents, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ledger.length === LEDGER_LIMIT && <p className="px-5 py-3 text-xs text-stone-500">{t("activityLimited", { count: LEDGER_LIMIT })}</p>}
      </Card>

      {payments.some((x) => x.status !== "succeeded") && (
        <Card>
          <CardTitle>{t("payments")}</CardTitle>
          <ul className="divide-y divide-stone-100 text-sm">
            {payments.map((x) => (
              <li key={x.id} className="flex items-center justify-between py-2">
                <span>{formatDateTime(x.createdAt, locale, tz)} · {formatCents(x.amountCents, locale)}</span>
                <span className="flex items-center gap-2">
                  {x.failureReason && <span className="text-stone-500">{showStored(locale, x.failureReason, x.failureMsg)}</span>}
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
