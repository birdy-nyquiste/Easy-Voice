"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { TIME_ZONE_COOKIE } from "@/lib/ui-prefs";

/**
 * Tells the server the browser's time zone (a cookie), so pages show times in it. Pages are rendered
 * on the server, which otherwise only knows its own zone (UTC on Vercel); when the zone is new or has
 * changed (travel), the page is refreshed once to show local times.
 */
export function TimeZoneSync({ current }: { current: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || zone === current) return;
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [current, router]);
  return null;
}
