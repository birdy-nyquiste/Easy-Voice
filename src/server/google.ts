import { Google } from "arctic";
import { config } from "@/lib/config";

export function googleClient(): Google {
  return new Google(
    config.google.clientId,
    config.google.clientSecret,
    `${config.appUrl}/api/auth/google/callback`,
  );
}
