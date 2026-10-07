import { config } from "@/lib/config";

/** Sends via Resend when configured; otherwise logs to the server console (dev). */
export async function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void> {
  if (!config.email.resendApiKey) {
    console.log(`\n[email:dev] to=${msg.to}\n  ${msg.subject}\n  ${msg.text}\n`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.email.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.email.from, to: msg.to, subject: msg.subject, text: msg.text }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status} ${await res.text()}`);
}
