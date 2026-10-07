import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardTitle, Empty, PageHeader, StatusBadge, buttonClass, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { userMessage } from "@/lib/errors";
import { formatCents, formatDateTime, formatPhone } from "@/lib/format";
import { listUserAgents } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listUserNumbers, refreshPendingNumbers, searchAvailableNumbers } from "@/server/numbers";
import { assignAgentAction, buyNumberAction, releaseNumberAction, simulateInboundAction } from "./actions";

export default async function NumbersPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  const user = await requireUser();
  const { area } = await searchParams;
  await refreshPendingNumbers(user.id);
  const [numbers, agents] = await Promise.all([listUserNumbers(user.id), listUserAgents(user.id)]);
  const owned = numbers.filter((n) => n.status !== "failed");
  const canBuy = owned.length < config.limits.numbersPerUser;

  let results: Awaited<ReturnType<typeof searchAvailableNumbers>> = [];
  let searchError: string | undefined;
  if (canBuy && area !== undefined) {
    try {
      results = await searchAvailableNumbers(area.trim());
    } catch (err) {
      searchError = userMessage(err, "Number search failed. Try again.");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone numbers"
        description={`US local numbers, ${formatCents(config.pricing.numberMonthlyCents)}/month, charged from your balance.`}
      />

      {numbers.length === 0 ? (
        <Empty>You don&apos;t have a number yet. Search for one below.</Empty>
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
                    <p className="mt-1 text-xs text-stone-500">Renews {formatDateTime(n.paidThrough)}</p>
                  )}
                  {n.status === "pending" && <p className="mt-1 text-xs text-stone-500">Activating with the carrier… refresh in a moment.</p>}
                  {n.failureReason && n.status === "failed" && <p className="mt-1 text-sm text-red-600">{n.failureReason}</p>}
                </div>
                {n.status === "active" && (
                  <div className="flex flex-wrap items-start gap-3">
                    <ActionForm action={assignAgentAction} className="flex items-center gap-2">
                      <input type="hidden" name="numberId" value={n.id} />
                      <select name="agentId" defaultValue={n.agentId ?? ""} className={`${inputClass} w-48`}>
                        <option value="">No agent (calls rejected)</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id} disabled={a.status !== "ready"}>
                            {a.name}
                            {a.status !== "ready" ? ` (${a.status})` : ""}
                          </option>
                        ))}
                      </select>
                      <SubmitButton variant="secondary">Save</SubmitButton>
                    </ActionForm>
                    <ActionForm action={releaseNumberAction}>
                      <input type="hidden" name="numberId" value={n.id} />
                      <SubmitButton variant="danger" confirm={`Release ${formatPhone(n.e164)}? You will lose this number permanently.`}>
                        Release
                      </SubmitButton>
                    </ActionForm>
                  </div>
                )}
                {n.status === "failed" && (
                  <ActionForm action={releaseNumberAction}>
                    <input type="hidden" name="numberId" value={n.id} />
                    <SubmitButton variant="secondary">Dismiss</SubmitButton>
                  </ActionForm>
                )}
              </div>
              {config.telnyx.mode === "mock" && n.status === "active" && (
                <ActionForm action={simulateInboundAction} className="mt-4 border-t border-stone-100 pt-3">
                  <input type="hidden" name="e164" value={n.e164} />
                  <SubmitButton variant="secondary">Simulate an inbound call</SubmitButton>
                </ActionForm>
              )}
            </Card>
          ))}
        </div>
      )}

      {canBuy && (
        <Card>
          <CardTitle>Get a number</CardTitle>
          <form className="flex gap-2" action="/numbers">
            <input name="area" defaultValue={area} placeholder="Area code, e.g. 415" inputMode="numeric" maxLength={3} className={`${inputClass} max-w-48`} />
            <button className={buttonClass("secondary")}>Search</button>
          </form>
          {searchError && <p className="mt-3 text-sm text-red-600">{searchError}</p>}
          {area !== undefined && !searchError && results.length === 0 && (
            <p className="mt-3 text-sm text-stone-500">No numbers available for that area code. Try another.</p>
          )}
          {results.length > 0 && (
            <ul className="mt-4 divide-y divide-stone-100">
              {results.map((r) => (
                <li key={r.e164} className="flex items-center justify-between py-2">
                  <span>
                    <span className="font-mono">{formatPhone(r.e164)}</span>
                    <span className="ml-2 text-sm text-stone-500">{[r.locality, r.region].filter(Boolean).join(", ")}</span>
                  </span>
                  <ActionForm action={buyNumberAction} className="text-right">
                    <input type="hidden" name="e164" value={r.e164} />
                    <SubmitButton pendingText="Ordering…" confirm={`Buy ${formatPhone(r.e164)} for ${formatCents(config.pricing.numberMonthlyCents)}/month?`}>
                      Buy
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
