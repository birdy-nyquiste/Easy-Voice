import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { runDailyJobs } from "@/server/cron";

// Vercel Cron sends GET with "Authorization: Bearer $CRON_SECRET".
export async function GET(req: NextRequest) {
  if (!config.cronSecret || req.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runDailyJobs());
}
