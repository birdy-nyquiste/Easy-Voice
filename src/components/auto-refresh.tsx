"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** After this, the interval doubles up to SLOWEST_MS: most things in flight settle within a minute. */
const FAST_FOR_MS = 60_000;
const SLOWEST_MS = 30_000;

/**
 * Re-render the server component periodically while something is in flight. Every tick re-runs the
 * page's queries (and may call the provider), so it slows down after the first minute, stops after
 * `maxMs` (a call whose hangup never arrives would otherwise poll forever) and skips hidden tabs.
 * Coming back to the tab refreshes at once and starts over. The default outlasts the longest call (30 min).
 */
export function AutoRefresh({ everyMs = 2000, maxMs = 40 * 60_000 }: { everyMs?: number; maxMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = Date.now();
    let delay = everyMs;

    const schedule = () => {
      clearTimeout(timer);
      const elapsed = Date.now() - started;
      if (document.visibilityState === "hidden" || elapsed >= maxMs) return;
      if (elapsed >= FAST_FOR_MS) delay = Math.min(delay * 2, Math.max(SLOWEST_MS, everyMs));
      timer = setTimeout(() => {
        router.refresh();
        schedule();
      }, delay);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(timer);
        return;
      }
      router.refresh();
      started = Date.now();
      delay = everyMs;
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, everyMs, maxMs]);
  return null;
}
