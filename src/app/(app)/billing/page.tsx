import { redirect } from "next/navigation";

/** Billing moved under Account; Stripe checkouts started before the move still return here. */
export default async function OldBillingPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = new URLSearchParams(await searchParams).toString();
  redirect(`/account/billing${q ? `?${q}` : ""}`);
}
