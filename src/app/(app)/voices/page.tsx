import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Field, PageHeader, StatusBadge, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatMegabytes } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { listStockVoices, listUserVoices, refreshProcessingVoices } from "@/server/voices";
import { cloneVoiceAction, deleteVoiceAction } from "./actions";
import { SampleInput } from "./sample-input";

export default async function VoicesPage() {
  const user = await requireUser();
  await refreshProcessingVoices(user.id);
  const [stock, clones] = await Promise.all([listStockVoices(), listUserVoices(user.id)]);
  const activeClones = clones.filter((c) => c.status !== "failed");
  const canClone = activeClones.length < config.limits.clonedVoicesPerUser;

  return (
    <div className="space-y-6">
      <PageHeader title="Voices" description="Use a built-in voice for your agent, or clone your own." />

      <Card>
        <CardTitle>Your cloned voices</CardTitle>
        {clones.length === 0 ? (
          <p className="text-sm text-stone-500">No cloned voices yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {clones.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{v.name}</span>
                  <Badge>{v.language === "zh" ? "Mandarin" : "English"}</Badge>
                  <StatusBadge status={v.status} />
                  {v.failureReason && <span className="text-red-600">{v.failureReason}</span>}
                </span>
                <ActionForm action={deleteVoiceAction}>
                  <input type="hidden" name="voiceId" value={v.id} />
                  <SubmitButton variant="danger" confirm={`Delete voice "${v.name}"?`}>Delete</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canClone && (
        <Card>
          <CardTitle>Clone a voice · {formatCents(config.pricing.voiceCloneCents)}</CardTitle>
          <ActionForm action={cloneVoiceAction} className="space-y-4">
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
            <Field label="Audio sample" hint={`10–15 seconds of clear speech, one speaker, no background noise. Max ${formatMegabytes(config.limits.cloneSampleBytes)}.`}>
              <SampleInput maxBytes={config.limits.cloneSampleBytes} />
            </Field>
            <label className="flex items-start gap-2 text-sm text-stone-700">
              <input type="checkbox" name="consent" required className="mt-0.5" />
              <span>This is my own voice, or I have the speaker&apos;s explicit permission to clone it.</span>
            </label>
            <SubmitButton pendingText="Uploading…">Clone voice</SubmitButton>
          </ActionForm>
        </Card>
      )}

      <Card>
        <CardTitle>Built-in voices</CardTitle>
        <ul className="grid gap-2 sm:grid-cols-2">
          {stock.map((v) => (
            <li key={v.ref} className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-sm">
              <span className="font-medium">{v.name}</span>
              <span className="flex gap-1.5">
                {v.speaks.includes("zh") ? <Badge tone="green">Mandarin + English</Badge> : <Badge>English only</Badge>}
                {v.gender && <Badge>{v.gender}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
