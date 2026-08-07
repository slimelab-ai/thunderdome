import test from 'node:test';
import assert from 'node:assert/strict';
import { Analytics } from '../src/analytics.js';

const OUTBOX_KEY = 'thunderdome_analytics_outbox_v1';

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.writes = new Map();
  }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
    this.values.set(key, String(value));
  }
  outboxWrites() { return this.writes.get(OUTBOX_KEY) ?? 0; }
}

// A macrotask, so every queued microtask — including an in-flight flush's continuation
// chain — has drained before the assertions run.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// Acknowledges whatever the batch actually contained, which also asserts the request
// body this client hand-assembles is still well-formed JSON.
const acceptWholeBatch = async (_endpoint, init) => {
  const { events } = JSON.parse(init.body);
  return { ok: true, json: async () => ({ accepted: events.length, duplicates: 0 }) };
};

function makeAnalytics(storage, fetchImpl = async () => ({
  ok: true,
  json: async () => ({ accepted: 1, duplicates: 0 }),
})) {
  let id = 0;
  return new Analytics({
    storage,
    fetchImpl,
    randomUUID: () => `generated-${++id}`,
    now: () => new Date('2026-07-24T06:00:00.000Z'),
    autoStart: false,
    // Zero-delay coalescing so `settle()` drains the persist timer; the production
    // default only stretches the window, it does not change the write-once property
    // these tests pin down.
    persistDelayMs: 0,
  });
}

test('stable event IDs are queued once and survive an Analytics reload', async () => {
  const storage = new MemoryStorage();
  const first = makeAnalytics(storage);
  first.emit('match_terminal', { terminal_reason: 'player_win' }, { eventId: 'terminal-1' });
  first.emit('match_terminal', { terminal_reason: 'recovered_incomplete' }, { eventId: 'terminal-1' });

  assert.equal(first.queue.length, 1);
  assert.equal(first.queue[0].payload.terminal_reason, 'player_win');
  assert.equal(first.isDurablyQueued('terminal-1'), true);

  const reloaded = makeAnalytics(storage);
  assert.equal(reloaded.queue.length, 1);
  assert.equal(reloaded.queue[0].event_id, 'terminal-1');
  await reloaded.flush();
  assert.equal(reloaded.queue.length, 0);
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).length, 0);
  assert.equal(reloaded.acknowledgedEvents, 1);
});

test('collector duplicate acknowledgement safely drains a retried event', async () => {
  const storage = new MemoryStorage();
  const analytics = makeAnalytics(storage, async () => ({
    ok: true,
    json: async () => ({ accepted: 0, duplicates: 1 }),
  }));
  analytics.emit('match_terminal', { terminal_reason: 'player_loss' }, { eventId: 'terminal-2' });

  await analytics.flush();

  assert.equal(analytics.queue.length, 0);
  assert.equal(analytics.deliveryFailures, 0);
  assert.equal(analytics.acknowledgedEvents, 1);
});

test('an invalid acknowledgement never removes pending records', async () => {
  const storage = new MemoryStorage();
  const analytics = makeAnalytics(storage, async () => ({
    ok: true,
    json: async () => ({ accepted: 0, duplicates: 0 }),
  }));
  analytics.emit('match_terminal', { terminal_reason: 'player_win' }, { eventId: 'terminal-3' });

  await analytics.flush();

  assert.equal(analytics.queue.length, 1);
  assert.equal(analytics.isDurablyQueued('terminal-3'), true);
  assert.equal(analytics.deliveryFailures, 1);
});

test('an oversized restored record is compacted and cannot block later events', () => {
  const storage = new MemoryStorage({
    [OUTBOX_KEY]: JSON.stringify([
      {
        schema_version: 1,
        event_id: 'oversized',
        event_type: 'optional_detail',
        client_time: '2026-07-24T05:59:00.000Z',
        payload: { inventory: 'X'.repeat(100_000) },
      },
      {
        schema_version: 1,
        event_id: 'terminal-4',
        event_type: 'match_terminal',
        client_time: '2026-07-24T06:00:00.000Z',
        payload: { terminal_reason: 'player_win' },
      },
    ]),
  });
  const analytics = makeAnalytics(storage);
  const batch = analytics.nextBatch();

  assert.deepEqual(batch.map(event => event.event_id), ['oversized', 'terminal-4']);
  assert.equal(batch[0].payload.payload_omitted, true);
  assert.equal(batch[1].payload.terminal_reason, 'player_win');
});

test('simulation provenance is explicit and inherited by every emitted event', () => {
  const analytics = makeAnalytics(new MemoryStorage());
  analytics.setSimulationContext({
    batchId: 'batch-10',
    seed: 20260730,
    pairId: 'pair-3',
    sideSwap: true,
    bots: ['alpha', 'bravo'],
  });
  analytics.emit('match_enter', {});
  analytics.emit('combat_decision', {});
  for (const event of analytics.queue) {
    assert.equal(event.simulation, true);
    assert.equal(event.simulation_batch_id, 'batch-10');
    assert.equal(event.simulation_seed, 20260730);
    assert.equal(event.simulation_pair_id, 'pair-3');
    assert.equal(event.simulation_side_swap, true);
    assert.deepEqual(event.simulation_bots, ['alpha', 'bravo']);
  }
});

test('simulation provenance rejects an ambiguous unseeded batch', () => {
  const analytics = makeAnalytics(new MemoryStorage());
  assert.throws(() => analytics.setSimulationContext({ batchId: 'batch-10' }), /numeric seed/);
});

test('a synchronous telemetry burst coalesces into a single outbox write', async () => {
  const storage = new MemoryStorage();
  const analytics = makeAnalytics(storage);

  // A headless match emits its whole run inside one synchronous task. Writing the
  // outbox per event is quadratic; one write per burst is the property that matters.
  for (let i = 0; i < 500; i++) analytics.emit('combat_frame', { frame: i });
  assert.equal(storage.outboxWrites(), 0, 'no outbox write should land mid-burst');

  await settle();
  assert.ok(storage.outboxWrites() <= 2,
    `500 events should coalesce, took ${storage.outboxWrites()} writes`);
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).length, 500);
});

test('lifecycle events are durable before emit returns, without waiting for a microtask', () => {
  const storage = new MemoryStorage();
  const analytics = makeAnalytics(storage);

  analytics.emit('combat_frame', { frame: 1 });
  analytics.emit('match_enter', {}, { eventId: 'enter-1' });

  assert.equal(analytics.isDurablyQueued('enter-1'), true);
  // The coalesced frame rides along on the lifecycle write rather than being lost.
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).length, 2);
});

test('the byte ledger tracks the queue across trimming and delivery', async () => {
  const storage = new MemoryStorage();
  const analytics = makeAnalytics(storage, acceptWholeBatch);

  for (let i = 0; i < 40; i++) analytics.emit('combat_frame', { blob: 'x'.repeat(200) });
  await settle();

  const ledger = () => analytics.outboxBytes();
  assert.equal(ledger(), storage.getItem(OUTBOX_KEY).length,
    'ledger must equal the bytes actually written');

  await analytics.flush();
  assert.equal(analytics.queue.length, 0);
  assert.equal(ledger(), storage.getItem(OUTBOX_KEY).length);
});

test('an oversized outbox sheds expendable records but never lifecycle events', async () => {
  const storage = new MemoryStorage();
  const analytics = makeAnalytics(storage);

  analytics.emit('match_enter', {}, { eventId: 'enter-2' });
  // Just under the 40 KiB per-event compaction limit, so these stay full size and it
  // is the outbox cap rather than per-event compaction that does the shedding.
  for (let i = 0; i < 150; i++) analytics.emit('combat_frame', { blob: 'x'.repeat(30_000) });
  analytics.emit('match_terminal', { terminal_reason: 'player_win' }, { eventId: 'terminal-5' });
  await settle();

  assert.ok(analytics.outboxBytes() <= 3_500_000, 'outbox must respect its cap');
  assert.ok(analytics.queue.length < 152, 'expendable frames should have been shed');
  assert.equal(analytics.isDurablyQueued('enter-2'), true);
  assert.equal(analytics.isDurablyQueued('terminal-5'), true);
});
