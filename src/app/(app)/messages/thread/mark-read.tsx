"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { markReadAction } from "../actions";

/** Marks the texts on screen read once they've rendered. */
export function MarkRead({ from, upTo, hasUnread }: { from: string; upTo: string; hasUnread: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!hasUnread) return;
    void markReadAction(from, upTo).then(() => router.refresh());
  }, [from, upTo, hasUnread, router]);
  return null;
}
