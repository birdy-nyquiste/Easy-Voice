import { NextResponse, type NextRequest } from "next/server";
import { handleCallEvent } from "@/server/calls/events";
import { voiceProvider } from "@/server/telnyx";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let event;
  try {
    event = await voiceProvider().parseWebhook(raw, req.headers);
  } catch (err) {
    console.warn("Rejected Telnyx webhook", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  try {
    await handleCallEvent(event);
  } catch (err) {
    console.error("Telnyx webhook processing failed", event.rawType, err);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
