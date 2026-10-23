import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { validTimeZone } from "@/lib/format";
import { TIME_ZONE_COOKIE } from "@/lib/ui-prefs";

/** The viewer's time zone as their browser reported it, or null before it has (see TimeZoneSync). */
export const viewerTimeZone = cache(async (): Promise<string | null> => validTimeZone((await cookies()).get(TIME_ZONE_COOKIE)?.value));
