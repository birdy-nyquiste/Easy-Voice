"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
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

function toggle(voice: string) {
  if (current.voice === voice && current.status !== "error" && current.status !== "idle") {
    player?.pause();
    set({ voice: null, status: "idle" });
    return;
  }
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

/** Play/stop a preview of a voice picker value ("stock:<ref>" or "clone:<voice uuid>"). */
export function PreviewButton({ voice, compact }: { voice: string; compact?: boolean }) {
  const p = usePlayer();
  useEffect(() => () => {
    if (current.voice === voice) {
      player?.pause();
      set({ voice: null, status: "idle" });
    }
  }, [voice]);
  const status = p.voice === voice ? p.status : "idle";
  const label: Record<PlayerState["status"], ReactNode> = {
    idle: "▶ Preview",
    loading: "Loading…",
    playing: "■ Stop",
    error: "Unavailable",
  };
  return (
    <button
      type="button"
      disabled={!voice}
      onClick={() => toggle(voice)}
      aria-label={status === "playing" ? "Stop preview" : "Play preview"}
      className={compact ? "shrink-0 rounded-md px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40" : `${buttonClass("secondary")} shrink-0`}
    >
      {label[status]}
    </button>
  );
}
