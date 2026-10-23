"use client";

import { useTranslations } from "next-intl";
import { useEffect, useSyncExternalStore } from "react";
import { buttonClass } from "./ui";

// One player for the whole page, so starting a preview stops whichever one was playing.
type PlayerState = { voice: string | null; status: "idle" | "loading" | "playing" | "error" };
let player: HTMLAudioElement | null = null;
let current: PlayerState = { voice: null, status: "idle" };
const listeners = new Set<() => void>();

function set(next: PlayerState) {
  current = next;
  listeners.forEach((l) => l());
}

/**
 * Stop the preview. Forgetting the element matters: pausing before playback starts rejects its
 * pending play(), which would otherwise show the voice as unavailable.
 */
function stop() {
  player?.pause();
  player = null;
  set({ voice: null, status: "idle" });
}

function toggle(voice: string) {
  if (current.voice === voice && current.status !== "error" && current.status !== "idle") return stop();
  player?.pause();
  const audio = new Audio(`/api/voices/preview?voice=${encodeURIComponent(voice)}`);
  player = audio;
  set({ voice, status: "loading" });
  audio.onplaying = () => player === audio && set({ voice, status: "playing" });
  audio.onended = () => player === audio && set({ voice: null, status: "idle" });
  audio.onerror = () => player === audio && set({ voice, status: "error" });
  audio.play().catch(() => player === audio && set({ voice, status: "error" }));
}

function usePlayer(): PlayerState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

/**
 * Play/stop a preview of a voice picker value ("stock:<ref>" or "clone:<voice uuid>"). Give the voice's
 * `name` where several buttons share a page, so each says which voice it plays.
 */
export function PreviewButton({ voice, name, compact }: { voice: string; name?: string; compact?: boolean }) {
  const t = useTranslations("preview");
  const p = usePlayer();
  useEffect(() => () => {
    if (current.voice === voice) stop();
  }, [voice]);
  const status = p.voice === voice ? p.status : "idle";
  const text = { idle: t("play"), loading: t("loading"), playing: t("stop"), error: t("unavailable") };
  // No label while loading or unavailable, so screen readers hear that state as it's shown.
  const label = name && status === "idle" ? t("playLabel", { name }) : name && status === "playing" ? t("stopLabel", { name }) : undefined;
  return (
    <button
      type="button"
      disabled={!voice}
      onClick={() => toggle(voice)}
      aria-label={label}
      className={compact ? "shrink-0 rounded-md px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40" : `${buttonClass("secondary")} shrink-0`}
    >
      {status === "idle" && <span aria-hidden="true">▶ </span>}
      {status === "playing" && <span aria-hidden="true">■ </span>}
      {text[status]}
    </button>
  );
}
