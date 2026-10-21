import type { ReactNode } from "react";

/** A read-only line naming a model a call runs on, shown next to the setting it serves. */
export function ModelRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <dl className="grid items-center gap-1 rounded-lg border border-stone-200 px-3 py-2.5 text-sm sm:grid-cols-[11rem_1fr]">
      <dt className="text-stone-500">{label}</dt>
      <dd>{children}</dd>
    </dl>
  );
}
