import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Field, Notice, PageHeader, StatusBadge, Tabs, inputClass } from "@/components/ui";
import { PreviewButton } from "@/components/voice-preview";
import { config } from "@/lib/config";
import { formatCents, formatMegabytes } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { getElevenLabsKey } from "@/server/elevenlabs-keys";
import { CLONING_UNAVAILABLE, listStockVoices, listUserVoices, refreshProcessingVoices } from "@/server/voices";
import { cloneVoiceAction, deleteVoiceAction } from "./actions";
import { SampleInput } from "./sample-input";

/**
 * Voice Library: every voice the user can give an agent, cloned or built-in, side by side.
 * Voice Lab: ways to make new voices (only cloning from a sample so far).
 */
export default async function VoicesPage({ searchParams }: { searchParams: Promise<{ library?: string }> }) {
  const user = await requireUser();
  await refreshProcessingVoices(user.id);
  const [stock, clones, elKey, { library }] = await Promise.all([
    listStockVoices(),
    listUserVoices(user.id),
    getElevenLabsKey(user.id),
    searchParams,
  ]);
  const tab = library === "cloned" || library === "built-in" ? library : clones.length ? "cloned" : "built-in";

  const cloning = config.features.voiceCloning;
  const elevenLabs = config.features.elevenLabs;
  const roomFor = (provider: "telnyx" | "elevenlabs") =>
    clones.filter((c) => c.provider === provider && c.status !== "failed").length < config.limits.clonedVoicesPerUser;
  // Clone providers the form offers, in order: ours, then third-party accounts the user has connected.
  const providers = [
    ...(cloning && roomFor("telnyx") ? (["telnyx"] as const) : []),
    ...(elevenLabs && elKey && roomFor("elevenlabs") ? (["elevenlabs"] as const) : []),
  ];
  // Third-party accounts are set up under Account → API keys, not here.
  const canAddService = elevenLabs && !elKey;
  const noProviderReason = canAddService
    ? "Connect a voice service to start cloning."
    : cloning || (elevenLabs && elKey)
      ? `You can have up to ${config.limits.clonedVoicesPerUser} cloned voices per service. Delete one to clone another.`
      : CLONING_UNAVAILABLE;

  return (
    <div className="space-y-6">
      <PageHeader title="Voices" description="The voices your agents can use, and where you make new ones." />

      <Card>
        <CardTitle>Voice Library</CardTitle>
        <Tabs
          tabs={[
            { href: "/voices?library=cloned", label: `Cloned (${clones.length})`, active: tab === "cloned" },
            { href: "/voices?library=built-in", label: `Built-in (${stock.length})`, active: tab === "built-in" },
          ]}
        />
        <div className="pt-4">
          {tab === "cloned" ? (
            clones.length === 0 ? (
              <p className="text-sm text-stone-500">No cloned voices yet. Make one in the Voice Lab below.</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {clones.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{v.name}</span>
                      <Badge>{v.language === "zh" ? "Mandarin" : "English"}</Badge>
                      {v.provider === "elevenlabs" && <Badge tone="blue">ElevenLabs</Badge>}
                      <StatusBadge status={v.status} />
                      {v.failureReason && <span className="text-red-600">{v.failureReason}</span>}
                    </span>
                    <span className="flex items-center gap-1">
                      {v.providerVoiceId && v.status !== "failed" && <PreviewButton voice={`clone:${v.id}`} compact />}
                      <ActionForm action={deleteVoiceAction}>
                        <input type="hidden" name="voiceId" value={v.id} />
                        <SubmitButton
                          variant="danger"
                          confirm={
                            v.provider === "elevenlabs"
                              ? `Delete voice "${v.name}"? It's also deleted from your ElevenLabs account.`
                              : `Delete voice "${v.name}"?`
                          }
                        >
                          Delete
                        </SubmitButton>
                      </ActionForm>
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {stock.map((v) => (
                <li key={v.ref} className="flex items-center justify-between gap-2 rounded-lg border border-stone-100 px-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1">
                    <PreviewButton voice={`stock:${v.ref}`} compact />
                    <span className="truncate font-medium">{v.name}</span>
                  </span>
                  <span className="flex shrink-0 gap-1.5">
                    {v.speaks.includes("zh") ? <Badge tone="green">Mandarin + English</Badge> : <Badge>English only</Badge>}
                    {v.gender && <Badge>{v.gender}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>Voice Lab</CardTitle>
        {/* One method today; more (e.g. designing a voice from a description) can join as tabs. */}
        <Tabs tabs={[{ href: "/voices", label: "Clone from a sample", active: true }]} />
        <div className="space-y-4 pt-4">
          <p className="text-sm text-stone-500">Record or upload someone speaking, and get a voice that sounds like them.</p>
          {!cloning && elevenLabs && (
            <Notice>
              {CLONING_UNAVAILABLE}
              {!elKey && " You can still clone with your own ElevenLabs account: use “Add a service” below."}
            </Notice>
          )}
          {providers.length === 0 && !canAddService ? (
            <p className="text-sm text-stone-500">{noProviderReason}</p>
          ) : (
            <ActionForm action={cloneVoiceAction} className="space-y-4">
              <Field label="Clone with">
                <div className="grid gap-2 sm:grid-cols-3">
                  {providers.map((p, i) => (
                    <label
                      key={p}
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-stone-200 px-3 py-2 text-sm has-[:checked]:border-stone-900"
                    >
                      <input type="radio" name="provider" value={p} defaultChecked={i === 0} required className="mt-0.5" />
                      <span>
                        <span className="font-medium">{p === "elevenlabs" ? "ElevenLabs" : "Easy Voice"}</span>
                        <span className="block text-stone-500">
                          {p === "elevenlabs"
                            ? "Your account. Free here; calls use your ElevenLabs credits."
                            : `${formatCents(config.pricing.voiceCloneCents)} from your balance.`}
                        </span>
                      </span>
                    </label>
                  ))}
                  {canAddService && (
                    <Link
                      href="/account/api-keys"
                      className="flex items-center gap-2 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm text-stone-600 hover:border-stone-500 hover:text-stone-900"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-stone-300 text-base leading-none">
                        +
                      </span>
                      <span>
                        <span className="font-medium">Add a service</span>
                        <span className="block text-stone-500">Connect your own ElevenLabs account.</span>
                      </span>
                    </Link>
                  )}
                </div>
              </Field>
              {providers.length === 0 ? (
                <p className="text-sm text-stone-500">{noProviderReason}</p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Name">
                      <input name="name" required maxLength={60} placeholder="My voice" className={inputClass} />
                    </Field>
                    <Field label="Sample language">
                      <select name="language" className={inputClass}>
                        <option value="en">English</option>
                        <option value="zh">Mandarin</option>
                      </select>
                    </Field>
                    <Field label="Voice type">
                      <select name="gender" className={inputClass}>
                        <option value="female">Female</option>
                        <option value="male">Male</option>
                      </select>
                    </Field>
                  </div>
                  <Field
                    label="Audio sample"
                    hint={`Clear speech, one speaker, no background noise: 10–15 seconds${providers.includes("elevenlabs") ? " (ElevenLabs works best with 1–2 minutes)" : ""}. Max ${formatMegabytes(config.limits.cloneSampleBytes)}.`}
                  >
                    <SampleInput maxBytes={config.limits.cloneSampleBytes} />
                  </Field>
                  <label className="flex items-start gap-2 text-sm text-stone-700">
                    <input type="checkbox" name="consent" required className="mt-0.5" />
                    <span>This is my own voice, or I have the speaker&apos;s explicit permission to clone it.</span>
                  </label>
                  <SubmitButton pendingText="Uploading…">Clone voice</SubmitButton>
                </>
              )}
            </ActionForm>
          )}
        </div>
      </Card>
    </div>
  );
}
