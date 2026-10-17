import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Field, Notice, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { requireUser } from "@/server/auth";
import { ELEVENLABS_UNAVAILABLE, getElevenLabsKey } from "@/server/elevenlabs-keys";
import { connectElevenLabsAction, disconnectElevenLabsAction } from "./actions";

/** Third-party accounts the user brings (docs/elevenlabs-notes.md §5). */
export default async function ApiKeysPage() {
  const user = await requireUser();
  const elKey = await getElevenLabsKey(user.id);

  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-500">
        Connect your own accounts with other services. Voices you clone with them can be used by your agents.
      </p>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>ElevenLabs</CardTitle>
          {elKey && <Badge tone="green">Connected</Badge>}
        </div>
        {!config.features.elevenLabs ? (
          <Notice>{ELEVENLABS_UNAVAILABLE}</Notice>
        ) : elKey ? (
          <div className="space-y-4">
            <p className="text-sm text-stone-700">
              Key ending <span className="font-mono">{elKey.keyHint}</span>. Voices you clone with ElevenLabs live in your ElevenLabs
              account, and calls with them use your ElevenLabs credits.{" "}
              <Link href="/voices" className="underline hover:text-stone-900">Clone a voice →</Link>
            </p>
            {/* Distinct keys so a key typed to connect isn't carried into this field. */}
            <ActionForm key="replace" action={connectElevenLabsAction} className="flex flex-wrap items-end gap-2">
              <div className="min-w-64 flex-1">
                <Field label="Replace key" hint="A new key for the same ElevenLabs account.">
                  <input name="apiKey" type="password" required autoComplete="off" placeholder="sk_…" className={inputClass} />
                </Field>
              </div>
              <SubmitButton variant="secondary" pendingText="Checking…">Replace</SubmitButton>
            </ActionForm>
            <ActionForm action={disconnectElevenLabsAction}>
              <SubmitButton
                variant="danger"
                confirm="Disconnect ElevenLabs? Voices cloned with it are removed here; they stay in your ElevenLabs account."
              >
                Disconnect
              </SubmitButton>
            </ActionForm>
          </div>
        ) : (
          <ActionForm key="connect" action={connectElevenLabsAction} className="space-y-4">
            <p className="text-sm text-stone-700">
              Clone voices in your own ElevenLabs account, free here, and use them in your agents. Calls with those voices use your
              ElevenLabs credits. Cloning needs the Starter plan or higher.
            </p>
            <Field
              label="ElevenLabs API key"
              hint="In ElevenLabs, open Developers → API keys and create a key with access to Text to Speech, Voices (write) and User (read)."
            >
              <input name="apiKey" type="password" required autoComplete="off" placeholder="sk_…" className={inputClass} />
            </Field>
            <SubmitButton pendingText="Checking…">Connect ElevenLabs</SubmitButton>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
