const ENDPOINT = '/api/analytics';
const SCHEMA_VERSION = 1;
const OUTBOX_KEY = 'thunderdome_analytics_outbox_v1';
const FLUSH_MS = 5000;
const HEARTBEAT_MS = 30000;
const MAX_BATCH_EVENTS = 100;
// Browser keepalive/sendBeacon bodies have a roughly 64 KiB transport budget.
// Stay below it so lifecycle delivery cannot fail before a request reaches nginx.
const MAX_BATCH_BYTES = 48_000;
const MAX_EVENT_BYTES = 40_000;
const MAX_OUTBOX_BYTES = 3_500_000;

const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

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

function loadOutbox() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class Analytics {
  constructor() {
    this.installationId = stableId('thunderdome_analytics_installation_id');
    this.sessionId = crypto.randomUUID();
    this.queue = loadOutbox();
    this.context = {};
    this.flushing = false;
    this.deliveryFailures = 0;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.heartbeat = setInterval(() => this.emit('analytics_client_heartbeat', {
      queued_events: this.queue.length,
      delivery_failures: this.deliveryFailures,
      visibility: document.visibilityState,
    }), HEARTBEAT_MS);
    addEventListener('pagehide', () => {
      this.persist();
      this.flush(true);
    });
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.persist();
        this.flush(true);
      }
    });
    addEventListener('error', event => this.emit('analytics_client_error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    }));
    addEventListener('unhandledrejection', event => this.emit('analytics_client_error', {
      message: String(event.reason?.message || event.reason || 'unhandled rejection'),
      stack: String(event.reason?.stack || '').slice(0, 4000),
    }));
    queueMicrotask(() => {
      this.emit('analytics_client_start', { recovered_events: this.queue.length });
      this.flush();
    });
  }

  setContext(context) {
    this.context = { ...this.context, ...context };
  }

  emit(type, payload = {}) {
    let event = {
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
    };
    const originalBytes = jsonBytes(event);
    if (originalBytes > MAX_EVENT_BYTES) {
      event = {
        ...event,
        payload: {
          payload_omitted: true,
          original_bytes: originalBytes,
          reason: 'event_exceeded_client_limit',
        },
      };
    }
    this.queue.push(event);
    this.persist();
    if (this.queue.length >= MAX_BATCH_EVENTS) this.flush();
    return event.event_id;
  }

  persist() {
    try {
      while (this.queue.length > 1 && jsonBytes(this.queue) > MAX_OUTBOX_BYTES) this.queue.shift();
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(this.queue));
    } catch {
      // Storage can be disabled or full. The live in-memory queue still retries.
    }
  }

  nextBatch() {
    const events = [];
    let bytes = 20;
    for (const event of this.queue) {
      const eventBytes = jsonBytes(event) + 1;
      if (events.length && (events.length >= MAX_BATCH_EVENTS || bytes + eventBytes > MAX_BATCH_BYTES)) break;
      events.push(event);
      bytes += eventBytes;
    }
    return events;
  }

  async flush(beacon = false) {
    if (!this.queue.length || this.flushing) return;
    const events = this.nextBatch();
    if (!events.length) return;
    const body = JSON.stringify({ events });
    if (beacon && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
      // Keep beaconed records in the persistent outbox until a later acknowledged
      // fetch removes them. Duplicate event_ids are safer than silent data loss.
      return;
    }
    this.flushing = true;
    let delivered = false;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      });
      if (!response.ok) throw new Error(`analytics HTTP ${response.status}`);
      const sentIds = new Set(events.map(event => event.event_id));
      this.queue = this.queue.filter(event => !sentIds.has(event.event_id));
      this.deliveryFailures = 0;
      this.persist();
      delivered = true;
    } catch {
      this.deliveryFailures++;
      this.persist();
    } finally {
      this.flushing = false;
    }
    if (delivered && this.queue.length) queueMicrotask(() => this.flush());
  }
}

export const analytics = new Analytics();
