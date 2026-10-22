/** "collapsed" or "expanded"; read by the (app) layout so the first render already has the right sidebar width. */
export const SIDEBAR_COOKIE = "ev_sidebar";

/** Interface language (a Locale code); see src/i18n/request.ts. */
export const LOCALE_COOKIE = "ev_locale";

/** The browser's IANA time zone, so the server can show times in it; set by TimeZoneSync. */
export const TIME_ZONE_COOKIE = "ev_tz";
