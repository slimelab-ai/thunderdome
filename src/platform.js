const detectedXboxNavigators = new WeakSet();

/**
 * Older Xbox Edge releases identify the console in their user agent or platform.
 * Current Chromium releases deliberately look like desktop Windows in both, but
 * expose "Xbox" through User-Agent Client Hints instead.
 */
export function isXboxBrowser(nav = globalThis.navigator, loc = globalThis.location) {
  // A query override makes the real compatibility path testable on desktop and
  // gives support a recovery switch if a future console UA drops the Xbox token.
  if (new URLSearchParams(loc?.search || '').get('compat') === 'xbox') return true;
  if (nav && detectedXboxNavigators.has(nav)) return true;
  const signature = `${nav?.userAgent || ''} ${nav?.platform || ''} ${nav?.userAgentData?.model || ''}`;
  return /\bXbox(?: One)?\b/i.test(signature);
}

/**
 * Resolve the high-entropy model hint before game setup. Edge 147 on Xbox One X
 * reports a normal Windows UA and only reveals `model: "Xbox"` through this call.
 */
export async function detectXboxBrowser(nav = globalThis.navigator, loc = globalThis.location) {
  if (isXboxBrowser(nav, loc)) return true;
  try {
    const hints = await nav?.userAgentData?.getHighEntropyValues?.(['model']);
    if (/\bXbox(?: One)?\b/i.test(hints?.model || '')) {
      if (nav && (typeof nav === 'object' || typeof nav === 'function')) detectedXboxNavigators.add(nav);
      return true;
    }
  } catch {
    // Client Hints can be denied. The game remains usable as an ordinary browser.
  }
  return false;
}

export async function requestBrowserFullscreen(doc = globalThis.document) {
  if (doc?.fullscreenElement || !doc?.documentElement?.requestFullscreen) return false;
  try {
    await doc.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch {
    return false;
  }
}
