import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { Notice } from "@/components/ui";
import type { User } from "@/db/schema";
import { config } from "@/lib/config";
import { formatCents, formatDate } from "@/lib/format";
import { negativeBalanceReleaseDate } from "@/server/billing/ledger";
import { viewerTimeZone } from "@/server/time-zone";

/**
 * What a negative balance means: calls are blocked, but the number's rental (and the texts it
 * receives) are still charged, and the number is released on a set day unless the user tops up.
 */
export async function NegativeBalanceNotice({
  user,
  hasNumber,
  linkToBilling = false,
}: {
  user: User;
  /** Whether the user has an active number. */
  hasNumber: boolean;
  linkToBilling?: boolean;
}) {
  const [t, locale, tz] = await Promise.all([getTranslations("billing"), getLocale(), viewerTimeZone()]);
  const link = (chunks: ReactNode) =>
    linkToBilling ? (
      <Link href="/account/billing" className="font-medium underline">
        {chunks}
      </Link>
    ) : (
      chunks
    );
  const releaseOn = user.negativeSince && negativeBalanceReleaseDate(user.negativeSince);
  return (
    <Notice tone="red">
      {t("balanceNegative", { amount: formatCents(user.balanceCents, locale) })}
      {hasNumber && t(config.features.inboundSms ? "rentalAndTextsStillCharged" : "rentalStillCharged")}
      {hasNumber &&
        releaseOn &&
        // Past the grace period, the next daily run releases it.
        (releaseOn.getTime() > Date.now()
          ? t.rich("releaseBy", { date: formatDate(releaseOn, locale, tz), link })
          : t.rich("releaseDue", { link }))}
    </Notice>
  );
}
