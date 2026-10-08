import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { voicePreview } from "@/server/voices";

/** GET ?voice=stock:<ref> | clone:<voice uuid> → audio to play in the voice pickers. */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const preview = await voicePreview(user.id, req.nextUrl.searchParams.get("voice") ?? "");
    if (!preview) return NextResponse.json({ error: "not found" }, { status: 404 });
    return new NextResponse(preview.audio, {
      headers: { "Content-Type": preview.contentType, "Cache-Control": "private, max-age=86400" },
    });
  } catch (err) {
    console.error("voice preview failed", err);
    return NextResponse.json({ error: "preview unavailable" }, { status: 502 });
  }
}
