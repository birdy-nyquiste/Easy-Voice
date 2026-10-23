import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Empty, Notice, PageHeader, StatusBadge, buttonClass, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { UserError, userMessage } from "@/lib/errors";
import { formatCents, formatDate, formatPhone } from "@/lib/format";
import { showStored } from "@/lib/stored-text";
import { listUserAgents } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listRecentNegativeBalanceReleases, listUserNumbers, refreshPendingNumbers, searchAvailableNumbers } from "@/server/numbers";
import { NegativeBalanceNotice } from "../negative-balance-notice";
import { assignAgentAction, buyNumberAction, releaseNumberAction, simulateInboundAction, simulateTextAction } from "./actions";
import { viewerTimeZone } from "@/server/time-zone";
import { currentBalanceCents } from "@/server/billing/ledger";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("numbers"))("title") };
}

export default async function NumbersPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  const user = await requireUser();
  const { area } = await searchParams;
  const [t, tc, ts, locale] = await Promise.all([getTranslations("numbers"), getTranslations("common"), getTranslations("status"), getLocale()]);
  const tz = await viewerTimeZone();
  // A failed order is refunded while this renders: then the user row read earlier is out of date.
  const balanceCents = (await refreshPendingNumbers(user.id)) ? await currentBalanceCents(user.id) : user.balanceCents;
  const [numbers, agents, releasedForBalance] = await Promise.all([
    listUserNumbers(user.id),
    listUserAgents(user.id),
    listRecentNegativeBalanceReleases(user.id),
  ]);
  const owned = numbers.filter((n) => n.status !== "failed");
  const canBuy = owned.length < config.limits.numbersPerUser;
  // The first month is charged up front, so say so before the user searches and picks one.
  const canAfford = balanceCents >= config.pricing.numberMonthlyCents;
  // Each render asks the provider about pending orders. A row without an order id is a lost order,
  // looked up only once it is an hour old, so polling wouldn't settle it any sooner.
  const activating = numbers.some((n) => n.status === "pending" && n.providerOrderId);

  let results: Awaited<ReturnType<typeof searchAvailableNumbers>> = [];
  let searchError: string | undefined;
  if (canBuy && area !== undefined) {
    try {
      results = await searchAvailableNumbers(area.trim());
    } catch (err) {
      console.error("Number search failed", { area }, err);
      searchError = err instanceof UserError ? userMessage(err, locale) : t("searchFailed");
    }
  }

  return (
    <div className="space-y-6">
      {activating && <AutoRefresh everyMs={5000} />}
      <PageHeader
        title={t("title")}
        description={t("description", { price: formatCents(config.pricing.numberMonthlyCents, locale) })}
      />

      {balanceCents < 0 && numbers.some((n) => n.status === "active") && (
        <NegativeBalanceNotice user={user} hasNumber linkToBilling />
      )}

      {releasedForBalance.map((n) => (
        <Notice key={n.id} tone="red">
          {t.rich("releasedNegative", {
            number: formatPhone(n.e164),
            date: formatDate(n.releasedAt, locale, tz),
            link: (chunks) => (
              <Link href="/account/billing" className="font-medium underline">
                {chunks}
              </Link>
            ),
          })}
        </Notice>
      ))}

      {numbers.length === 0 ? (
        <Empty>{t("empty")}</Empty>
      ) : (
        <div className="space-y-3">
          {numbers.map((n) => (
            <Card key={n.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-lg">{formatPhone(n.e164)}</span>
                    <StatusBadge status={n.status} />
                  </div>
                  {n.status === "active" && n.paidThrough && (
                    <p className="mt-1 text-xs text-stone-500">{t("renews", { date: formatDate(n.paidThrough, locale, tz) })}</p>
                  )}
                  {n.status === "active" && config.features.inboundSms && (
                    <p className="mt-1 text-xs text-stone-500">
                      {n.smsEnabledAt ? (
                        t.rich("receivesTexts", {
                          price: formatCents(config.pricing.smsInboundPerPartCents, locale),
                          link: (chunks) => (
                            <Link href="/messages" className="underline">
                              {chunks}
                            </Link>
                          ),
                        })
                      ) : (
                        t("smsSettingUp")
                      )}
                    </p>
                  )}
                  {n.status === "pending" && <p className="mt-1 text-xs text-stone-500">{t("activating")}</p>}
                  {n.failureReason && n.status === "failed" && <p className="mt-1 text-sm text-red-600">{showStored(locale, n.failureReason, n.failureMsg)}</p>}
                </div>
                {n.status === "active" && (
                  <div className="flex flex-wrap items-start gap-3">
                    <ActionForm action={assignAgentAction} className="flex items-center gap-2">
                      <input type="hidden" name="numberId" value={n.id} />
                      <select name="agentId" aria-label={t("agentLabel")} defaultValue={n.agentId ?? ""} className={`${inputClass} w-48`}>
                        <option value="">{t("noAgentOption")}</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id} disabled={a.status !== "ready"}>
                            {a.status === "ready" ? a.name : t("agentStatus", { name: a.name, status: ts(a.status) })}
                          </option>
                        ))}
                      </select>
                      <SubmitButton variant="secondary">{tc("save")}</SubmitButton>
                    </ActionForm>
                    <ActionForm action={releaseNumberAction}>
                      <input type="hidden" name="numberId" value={n.id} />
                      <SubmitButton variant="danger" confirm={t("releaseConfirm", { number: formatPhone(n.e164) })}>
                        {t("release")}
                      </SubmitButton>
                    </ActionForm>
                  </div>
                )}
                {n.status === "failed" && (
                  <ActionForm action={releaseNumberAction}>
                    <input type="hidden" name="numberId" value={n.id} />
                    <SubmitButton variant="secondary">{t("dismiss")}</SubmitButton>
                  </ActionForm>
                )}
              </div>
              {config.telnyx.mode === "mock" && n.status === "active" && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
                  <ActionForm action={simulateInboundAction}>
                    <input type="hidden" name="numberId" value={n.id} />
                    <SubmitButton variant="secondary">{t("simulateCall")}</SubmitButton>
                  </ActionForm>
                  {n.smsEnabledAt && (
                    <ActionForm action={simulateTextAction}>
                      <input type="hidden" name="numberId" value={n.id} />
                      <SubmitButton variant="secondary">{t("simulateText")}</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {canBuy && (
        <Card>
          <CardTitle>{t("get")}</CardTitle>
          {!canAfford && (
            <div className="mb-4">
              <Notice>
                {t.rich("needCredit", {
                  price: formatCents(config.pricing.numberMonthlyCents, locale),
                  link: (chunks) => (
                    <Link href="/account/billing" className="font-medium underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </Notice>
            </div>
          )}
          <form className="flex gap-2" action="/numbers">
            <input
              name="area"
              aria-label={t("areaCode")}
              defaultValue={area}
              placeholder={t("areaPlaceholder")}
              inputMode="numeric"
              maxLength={3}
              className={`${inputClass} max-w-48`}
            />
            <button className={buttonClass("secondary")}>{t("search")}</button>
          </form>
          {searchError && <p className="mt-3 text-sm text-red-600">{searchError}</p>}
          {results.length > 0 && results.every((r) => r.nearby) && (
            <p className="mt-3 text-sm text-stone-500">{t("nearbyOnly", { area: area ?? "" })}</p>
          )}
          {area !== undefined && !searchError && results.length === 0 && (
            <p className="mt-3 text-sm text-stone-500">{t("noResults")}</p>
          )}
          {results.length > 0 && (
            <ul className="mt-4 divide-y divide-stone-100">
              {results.map((r) => (
                <li key={r.e164} className="flex items-center justify-between py-2">
                  <span>
                    <span className="font-mono">{formatPhone(r.e164)}</span>
                    <span className="ml-2 text-sm text-stone-500">{[r.locality, r.region].filter(Boolean).join(", ")}</span>
                    {r.nearby && <span className="ml-2"><Badge tone="amber">{t("nearby")}</Badge></span>}
                  </span>
                  <ActionForm action={buyNumberAction} className="text-right">
                    <input type="hidden" name="e164" value={r.e164} />
                    <SubmitButton
                      disabled={!canAfford}
                      pendingText={t("ordering")}
                      confirm={t("buyConfirm", { number: formatPhone(r.e164), price: formatCents(config.pricing.numberMonthlyCents, locale) })}
                    >
                      {t("buy")}
                    </SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
