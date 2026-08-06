/**
 * Xbox Edge identifies the console in both its user agent and, on some releases,
 * navigator.platform. Keep the check tiny and injectable so console fallbacks can
 * be tested without pretending a desktop Chromium build is the Xbox browser.
 */
export function isXboxBrowser(nav = globalThis.navigator, loc = globalThis.location) {
  // A query override makes the real compatibility path testable on desktop and
  // gives support a recovery switch if a future console UA drops the Xbox token.
  if (new URLSearchParams(loc?.search || '').get('compat') === 'xbox') return true;
  const signature = `${nav?.userAgent || ''} ${nav?.platform || ''}`;
  return /\bXbox(?: One)?\b/i.test(signature);
}
