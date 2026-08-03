const ENDPOINT = '/api/analytics';
const SCHEMA_VERSION = 1;
const OUTBOX_KEY = 'thunderdome_analytics_outbox_v1';
const FLUSH_MS = 5000;
const HEARTBEAT_MS = 30000;
// How long ordinary telemetry may sit in memory before the outbox is rewritten to
// localStorage. It used to coalesce onto the next *microtask* — but a microtask
// checkpoint lands at the end of every rAF callback, so a firefight emitting
// combat_shot/sight/suppression events rewrote the whole outbox with a synchronous
// setItem once per frame, for the entire fight. One second bounds what a hard crash
// can lose from storage (the in-memory queue and pagehide persist cover the rest)
// without putting storage I/O on the frame.
const PERSIST_COALESCE_MS = 1000;
const MAX_BATCH_EVENTS = 100;
// Browser keepalive/sendBeacon bodies have a roughly 64 KiB transport budget.
// Stay below it so lifecycle delivery cannot fail before a request reaches nginx.
const MAX_BATCH_BYTES = 48_000;
const MAX_EVENT_BYTES = 40_000;
const MAX_OUTBOX_BYTES = 3_500_000;
// Shedding down to a low-water mark keeps trimming amortized. Trimming to the cap
// exactly means the very next event is over budget again, so every later emit
// re-scans the whole outbox to drop exactly one record.
const TRIM_TARGET_BYTES = 3_150_000;

const encoder = new TextEncoder();

// Serialising a record is the hottest operation in this module: the outbox is written
// whole on every persist, and each write used to re-walk every queued object. Records
// are never mutated once queued, so one cached string per record stays valid for life.
const serialCache = new WeakMap();

function serialize(event) {
  let cached = serialCache.get(event);
  if (!cached) {
    const json = JSON.stringify(event);
    cached = { json, bytes: encoder.encode(json).byteLength };
    serialCache.set(event, cached);
  }
  return cached;
}

// The outbox on disk is a JSON array: two brackets plus one comma between records.
const framedBytes = (bytes, count) => 2 + bytes + Math.max(0, count - 1);

function serializeEvents(events) {
  if (!events.length) return '[]';
  const fragments = new Array(events.length);
  for (let i = 0; i < events.length; i++) fragments[i] = serialize(events[i]).json;
  return `[${fragments.join(',')}]`;
}

const protectedLifecycleEvent = event =>
  event?.event_type === 'match_enter' || event?.event_type === 'match_terminal';

function compactOversizedEvent(event) {
  try {
    const bytes = serialize(event).bytes;
    if (bytes <= MAX_EVENT_BYTES) return event;
    return {
      ...event,
      payload: {
        payload_omitted: true,
        original_bytes: bytes,
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
    persistDelayMs = PERSIST_COALESCE_MS,
  } = {}) {
    this.storage = storage;
    this.persistDelayMs = persistDelayMs;
    this.randomUUID = randomUUID;
    this.fetchImpl = fetchImpl;
    this.navigator = navigatorImpl;
    this.now = now;
    this.installationId = stableId('thunderdome_analytics_installation_id', storage, randomUUID);
    this.sessionId = randomUUID();
    this.persistScheduled = false;
    this.setQueue(loadOutbox(storage));
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

  // Every queue replacement goes through here so the id index and the byte total
  // can never drift from the array they describe.
  setQueue(events) {
    this.queue = events;
    this.queuedIds = new Set();
    this.queueBytes = 0;
    for (const event of events) {
      this.queuedIds.add(event.event_id);
      this.queueBytes += serialize(event).bytes;
    }
  }

  outboxBytes() {
    return framedBytes(this.queueBytes, this.queue.length);
  }

  // Drops the oldest expendable records in one pass. Lifecycle events are never shed:
  // a missing match_terminal silently corrupts every funnel built on it.
  trimOutbox() {
    if (this.outboxBytes() <= MAX_OUTBOX_BYTES) return;
    const dropped = new Set();
    let bytes = this.queueBytes;
    let count = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (count <= 1 || framedBytes(bytes, count) <= TRIM_TARGET_BYTES) break;
      const event = this.queue[i];
      if (protectedLifecycleEvent(event)) continue;
      dropped.add(i);
      bytes -= serialize(event).bytes;
      count--;
    }
    if (!dropped.size) return;
    this.setQueue(this.queue.filter((_, index) => !dropped.has(index)));
  }

  // Lifecycle events reach storage before emit() returns. Ordinary telemetry
  // coalesces onto a timer (see PERSIST_COALESCE_MS): rewriting the whole outbox per
  // event is quadratic, and per *frame* it is a synchronous setItem in the middle of
  // every firefight. `persistPending` remains the settle point — anything that needs
  // storage current (isDurablyQueued, pagehide) calls it and the timer becomes a
  // no-op.
  schedulePersist(event) {
    if (protectedLifecycleEvent(event)) {
      this.persist();
      return;
    }
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    setTimeout(() => this.persistPending(), this.persistDelayMs);
  }

  persistPending() {
    if (this.persistScheduled) this.persist();
  }

  emit(type, payload = {}, { eventId = null, context = null } = {}) {
    const id = eventId || this.randomUUID();
    if (this.queuedIds.has(id)) return id;
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
    this.queuedIds.add(event.event_id);
    this.queueBytes += serialize(event).bytes;
    // Bound memory even inside a synchronous burst that never reaches a persist.
    this.trimOutbox();
    this.schedulePersist(event);
    if (this.queue.length >= MAX_BATCH_EVENTS) this.flush();
    return id;
  }

  persist() {
    this.persistScheduled = false;
    try {
      this.trimOutbox();
      this.storage.setItem(OUTBOX_KEY, serializeEvents(this.queue));
      return true;
    } catch {
      this.storageFailures++;
      // The live in-memory queue still retries, and the next heartbeat exposes
      // that persistence was unavailable once storage starts working again.
      return false;
    }
  }

  isDurablyQueued(eventId) {
    // Settle any coalesced write first, so the answer describes storage as callers
    // will find it rather than as it was one microtask ago.
    this.persistPending();
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
      const eventBytes = serialize(event).bytes + 1;
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
    const body = `{"events":${serializeEvents(events)}}`;
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
      this.setQueue(this.queue.filter(event => !sentIds.has(event.event_id)));
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
