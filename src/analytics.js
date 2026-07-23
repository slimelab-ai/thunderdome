const ENDPOINT = '/api/analytics';
const SCHEMA_VERSION = 1;
const FLUSH_MS = 5000;
const MAX_BATCH = 100;

function stableId(key) {
  try {
    let value = localStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return crypto.randomUUID();
  }
}

export class Analytics {
  constructor() {
    this.installationId = stableId('thunderdome_analytics_installation_id');
    this.sessionId = crypto.randomUUID();
    this.queue = [];
    this.context = {};
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    addEventListener('pagehide', () => this.flush(true));
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush(true);
    });
  }

  setContext(context) {
    this.context = { ...this.context, ...context };
  }

  emit(type, payload = {}) {
    this.queue.push({
      schema_version: SCHEMA_VERSION,
      event_id: crypto.randomUUID(),
      event_type: type,
      client_time: new Date().toISOString(),
      installation_id: this.installationId,
      session_id: this.sessionId,
      trust: 'client_unverified',
      build: import.meta.env.VITE_BUILD_SHA || 'dev',
      ...this.context,
      payload,
    });
    if (this.queue.length >= MAX_BATCH) this.flush();
  }

  flush(beacon = false) {
    if (!this.queue.length) return;
    const events = this.queue.splice(0, MAX_BATCH);
    const body = JSON.stringify({ events });
    if (beacon && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      this.queue.unshift(...events);
      if (this.queue.length > 1000) this.queue.length = 1000;
    });
  }
}

export const analytics = new Analytics();
