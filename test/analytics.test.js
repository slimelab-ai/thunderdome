import test from 'node:test';
import assert from 'node:assert/strict';
import { Analytics } from '../src/analytics.js';

const OUTBOX_KEY = 'thunderdome_analytics_outbox_v1';

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

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
