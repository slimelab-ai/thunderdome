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
const protectedLifecycleEvent = event =>
  event?.event_type === 'match_enter' || event?.event_type === 'match_terminal';

function compactOversizedEvent(event) {
  try {
    if (jsonBytes(event) <= MAX_EVENT_BYTES) return event;
    return {
      ...event,
      payload: {
        payload_omitted: true,
        original_bytes: jsonBytes(event),
        reason: 'event_exceeded_client_limit',
      },
    };
  } catch {
    return null;
  }
}

function validQueuedEvent(event) {
  return event && typeof event === 'object' &&
    typeof event.event_id === 'string' &&
    typeof event.event_type === 'string' &&
    event.schema_version === SCHEMA_VERSION;
}

function stableId(key, storage, randomUUID) {
  try {
    let value = storage.getItem(key);
    if (!value) {
      value = randomUUID();
      storage.setItem(key, value);
    }
    return value;
  } catch {
    return randomUUID();
  }
}

function loadOutbox(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(OUTBOX_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validQueuedEvent).map(compactOversizedEvent).filter(Boolean);
  } catch {
    return [];
  }
}

export class Analytics {
  constructor({
    storage = globalThis.localStorage,
    randomUUID = () => globalThis.crypto.randomUUID(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    navigatorImpl = globalThis.navigator,
    now = () => new Date(),
    autoStart = true,
  } = {}) {
    this.storage = storage;
    this.randomUUID = randomUUID;
    this.fetchImpl = fetchImpl;
    this.navigator = navigatorImpl;
    this.now = now;
    this.installationId = stableId('thunderdome_analytics_installation_id', storage, randomUUID);
    this.sessionId = randomUUID();
    this.queue = loadOutbox(storage);
    this.context = {};
    this.flushing = false;
    this.deliveryFailures = 0;
    this.storageFailures = 0;
    this.acknowledgedEvents = 0;
    this.lastSuccessfulFlushAt = null;
    if (!autoStart) return;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.heartbeat = setInterval(() => {
      const oldest = this.queue[0];
      const oldestTime = oldest ? Date.parse(oldest.client_time) : NaN;
      this.emit('analytics_client_heartbeat', {
        queued_events: this.queue.length,
        delivery_failures: this.deliveryFailures,
        storage_failures: this.storageFailures,
        acknowledged_events: this.acknowledgedEvents,
        last_successful_flush_at: this.lastSuccessfulFlushAt,
        oldest_queued_event_id: oldest?.event_id || null,
        oldest_queued_event_type: oldest?.event_type || null,
        oldest_queued_event_age_seconds: Number.isFinite(oldestTime)
          ? Math.max(0, Math.round((Date.now() - oldestTime) / 1000))
          : null,
        visibility: document.visibilityState,
      });
    }, HEARTBEAT_MS);
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

  setSimulationContext({
    batchId,
    runner = 'headless_chromium',
    seed,
    pairId = null,
    sideSwap = null,
    bots = null,
  }) {
    if (!batchId || !Number.isFinite(Number(seed))) {
      throw new TypeError('simulation analytics require batchId and numeric seed');
    }
    this.context = {
      ...this.context,
      simulation: true,
      simulation_batch_id: String(batchId),
      simulation_runner: String(runner),
      simulation_seed: Number(seed),
      simulation_pair_id: pairId == null ? null : String(pairId),
      simulation_side_swap: sideSwap == null ? null : Boolean(sideSwap),
      simulation_bots: Array.isArray(bots) ? bots.map(String) : null,
    };
  }

  emit(type, payload = {}, { eventId = null, context = null } = {}) {
    const id = eventId || this.randomUUID();
    if (this.queue.some(event => event.event_id === id)) return id;
    let event = {
      schema_version: SCHEMA_VERSION,
      client_time: this.now().toISOString(),
      installation_id: this.installationId,
      session_id: this.sessionId,
      trust: 'client_unverified',
      build: import.meta.env?.VITE_BUILD_SHA || 'dev',
      ...this.context,
      ...(context || {}),
      event_id: id,
      event_type: type,
      payload,
    };
    event = compactOversizedEvent(event);
    if (!event) return id;
    this.queue.push(event);
    this.persist();
    if (this.queue.length >= MAX_BATCH_EVENTS) this.flush();
    return id;
  }

  persist() {
    try {
      while (this.queue.length > 1 && jsonBytes(this.queue) > MAX_OUTBOX_BYTES) {
        const expendable = this.queue.findIndex(event => !protectedLifecycleEvent(event));
        if (expendable < 0) break;
        this.queue.splice(expendable, 1);
      }
      this.storage.setItem(OUTBOX_KEY, JSON.stringify(this.queue));
      return true;
    } catch {
      this.storageFailures++;
      // The live in-memory queue still retries, and the next heartbeat exposes
      // that persistence was unavailable once storage starts working again.
      return false;
    }
  }

  isDurablyQueued(eventId) {
    try {
      const parsed = JSON.parse(this.storage.getItem(OUTBOX_KEY) || '[]');
      return Array.isArray(parsed) && parsed.some(event => event?.event_id === eventId);
    } catch {
      return false;
    }
  }

  nextBatch() {
    const events = [];
    let bytes = 20;
    for (const event of this.queue) {
      const eventBytes = jsonBytes(event) + 1;
      if (eventBytes > MAX_BATCH_BYTES) continue;
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
    if (beacon && this.navigator?.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
      // Keep beaconed records in the persistent outbox until a later acknowledged
      // fetch removes them. Duplicate event_ids are safer than silent data loss.
      return;
    }
    this.flushing = true;
    let delivered = false;
    try {
      const response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      });
      if (!response.ok) throw new Error(`analytics HTTP ${response.status}`);
      const acknowledgement = await response.json();
      const accepted = Number(acknowledgement?.accepted);
      const duplicates = Number(acknowledgement?.duplicates);
      if (!Number.isInteger(accepted) || accepted < 0 ||
          !Number.isInteger(duplicates) || duplicates < 0 ||
          accepted + duplicates !== events.length) {
        throw new Error('analytics acknowledgement did not cover the batch');
      }
      const sentIds = new Set(events.map(event => event.event_id));
      this.queue = this.queue.filter(event => !sentIds.has(event.event_id));
      this.deliveryFailures = 0;
      this.acknowledgedEvents += events.length;
      this.lastSuccessfulFlushAt = this.now().toISOString();
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

export const analytics = typeof window === 'undefined' ? null : new Analytics();
