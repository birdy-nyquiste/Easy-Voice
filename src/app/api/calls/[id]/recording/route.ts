import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { getRecordingUrl } from "@/server/calls";

/** Provider recording URLs expire within minutes, so mint a fresh one per playback. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const url = await getRecordingUrl(user.id, id);
  if (!url) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Provider URLs are absolute; the mock's is a path on this site.
  return NextResponse.redirect(new URL(url, req.url));
}
