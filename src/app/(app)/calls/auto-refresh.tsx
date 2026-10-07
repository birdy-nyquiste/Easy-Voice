"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the server component periodically while something is in flight. */
export function AutoRefresh({ everyMs = 2000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
