import { config } from "@/lib/config";

/**
 * Sends via Resend. Without RESEND_API_KEY, dev and tests print the message to the server console
 * instead; a production server refuses (resendApiKey throws), since sign-in codes must never reach its logs.
 */
export async function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void> {
  const apiKey = config.email.resendApiKey;
  if (!apiKey) {
    console.log(`\n[email:dev] to=${msg.to}\n  ${msg.subject}\n  ${msg.text}\n`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.email.from, to: msg.to, subject: msg.subject, text: msg.text }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status} ${await res.text()}`);
}
