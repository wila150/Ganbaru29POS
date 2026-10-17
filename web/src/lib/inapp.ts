/**
 * Google sign-in does not work inside app webviews (LINE, Facebook, Instagram…):
 * Google blocks them, and the popup/redirect loses its state ("missing initial state").
 */
export function inAppBrowser(): "line" | "other" | null {
  const ua = navigator.userAgent;
  if (/\bLine\//i.test(ua)) return "line";
  if (/FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|Threads|; wv\)/i.test(ua)) return "other";
  return null;
}

/** LINE opens the page in the phone's default browser when the URL carries openExternalBrowser=1. */
export function escapeLineBrowser(): boolean {
  if (inAppBrowser() !== "line") return false;
  const url = new URL(location.href);
  if (url.searchParams.get("openExternalBrowser") === "1") return false;
  url.searchParams.set("openExternalBrowser", "1");
  location.replace(url.toString());
  return true;
}
