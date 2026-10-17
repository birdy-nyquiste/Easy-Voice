import type { Locale } from "./locales";
import type { Messages } from "./messages";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
