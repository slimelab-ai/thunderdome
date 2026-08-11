import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_MATCH_KEY,
  MatchLifecycle,
  markKnownOutcome,
} from '../src/match-lifecycle.js';

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class FakeAnalytics {
  constructor({ durable = true, throws = false } = {}) {
    this.durable = durable;
    this.throws = throws;
    this.events = [];
    this.queued = new Set();
  }
  emit(type, payload, options) {
    if (this.throws) throw new Error('analytics unavailable');
    if (!this.queued.has(options.eventId)) {
      this.events.push({ type, payload, options });
      this.queued.add(options.eventId);
    }
    return options.eventId;
  }
  isDurablyQueued(id) {
    return this.durable && this.queued.has(id);
  }
}

function harness(options = {}) {
  const storage = options.storage || new MemoryStorage();
  const analytics = options.analytics || new FakeAnalytics();
  let id = 0;
  const lifecycle = new MatchLifecycle({
    analytics,
    storage,
    now: () => '2026-07-24T06:00:00.000Z',
    randomUUID: () => `event-${++id}`,
  });
  const active = lifecycle.begin({
    matchId: 'match-1',
    careerId: 'career-1',
    warId: 'career-1',
    mode: 'liquidation',
    round: 4,
  }, { game_mode: 'liquidation' });
  return { lifecycle, analytics, storage, active };
}

const terminalDetails = (winner = 'player') => ({
  winner,
  duration: 12.871,
  kills: 3,
  headshots: 1,
  final_squad: {
    player: { name: 'YOU', team: 'player', alive: true, hp: 12, maxHp: 100, inventory: 'omitted' },
    crew: [],
    enemies: [{ name: 'RIVAL 1', team: 'enemy', alive: false, hp: 0, maxHp: 100 }],
  },
  pre_settlement_economy: {
    player_money: 750,
    stake: 250,
    rival_money: 500,
    player_wins: 1,
    rival_wins: 2,
  },
});

test('last enemy outcome is journaled immediately and exactly once', () => {
  const { lifecycle, analytics, storage, active } = harness();
  const match = { ended: false, won: false, endTimer: 0 };

  const changed = markKnownOutcome(match, { won: true, endDelay: 2 },
    () => lifecycle.finalize('player_win', () => terminalDetails()));
  const duplicate = lifecycle.finalize('player_win', () => terminalDetails());

  assert.equal(changed, true);
  assert.deepEqual(match, { ended: true, won: true, endTimer: 2 });
  const terminals = analytics.events.filter(event => event.type === 'match_terminal');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].options.eventId, active.terminal_event_id);
  assert.equal(terminals[0].payload.terminal_reason, 'player_win');
  assert.equal(storage.getItem(ACTIVE_MATCH_KEY), null);
  assert.equal(duplicate, null);
});

test('player loss journals once while a living crew delays the outcome', () => {
  const { lifecycle, analytics } = harness();
  const match = { ended: false, won: false, endTimer: 0 };
  const livingCrew = [{ alive: true }];

  // Player death alone is not terminal while a squadmate remains alive.
  assert.equal(livingCrew.some(member => member.alive), true);
  assert.equal(analytics.events.filter(event => event.type === 'match_terminal').length, 0);

  livingCrew[0].alive = false;
  markKnownOutcome(match, { won: false, endDelay: 2.2 },
    () => lifecycle.finalize('player_loss', () => terminalDetails('rival')));
  markKnownOutcome(match, { won: false, endDelay: 2.2 },
    () => lifecycle.finalize('player_loss', () => terminalDetails('rival')));

  const terminals = analytics.events.filter(event => event.type === 'match_terminal');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].payload.winner, 'rival');
  assert.equal(terminals[0].payload.terminal_reason, 'player_loss');
});

test('explicit abandon and pagehide use canonical terminal reasons', () => {
  for (const reason of ['player_abandon', 'pagehide']) {
    const { lifecycle, analytics } = harness();
    lifecycle.finalize(reason, () => terminalDetails(null));
    const terminal = analytics.events.find(event => event.type === 'match_terminal');
    assert.equal(terminal.payload.terminal_reason, reason);
    assert.equal(terminal.payload.winner, null);
  }
});

test('startup recovery emits recovered_incomplete with the preallocated terminal ID', () => {
  const storage = new MemoryStorage();
  const interrupted = harness({
    storage,
    analytics: new FakeAnalytics({ durable: false }),
  });
  assert.ok(storage.getItem(ACTIVE_MATCH_KEY));

  const recoveredAnalytics = new FakeAnalytics();
  const recovered = new MatchLifecycle({
    analytics: recoveredAnalytics,
    storage,
    now: () => '2026-07-24T06:01:00.000Z',
    randomUUID: () => 'must-not-be-used',
  }).recoverIncomplete();

  assert.equal(recovered.event_id, interrupted.active.terminal_event_id);
  assert.equal(recovered.payload.terminal_reason, 'recovered_incomplete');
  assert.equal(recovered.payload.winner, null);
  assert.equal(storage.getItem(ACTIVE_MATCH_KEY), null);
});

test('interrupted terminal journal survives reload with its immutable outcome', () => {
  const storage = new MemoryStorage();
  const interrupted = harness({
    storage,
    analytics: new FakeAnalytics({ durable: false }),
  });
  const first = interrupted.lifecycle.finalize('player_win', () => terminalDetails());
  assert.ok(storage.getItem(ACTIVE_MATCH_KEY));

  const recoveredAnalytics = new FakeAnalytics();
  const recovered = new MatchLifecycle({
    analytics: recoveredAnalytics,
    storage,
    now: () => '2026-07-24T06:01:00.000Z',
  }).recoverIncomplete();

  assert.equal(recovered.event_id, first.event_id);
  assert.deepEqual(recovered.payload, first.payload);
  assert.equal(recovered.payload.terminal_reason, 'player_win');
  assert.equal(storage.getItem(ACTIVE_MATCH_KEY), null);
});

test('a new match cannot overwrite an older terminal marker awaiting durable queueing', () => {
  const storage = new MemoryStorage();
  const interruptedAnalytics = new FakeAnalytics({ durable: false });
  const first = harness({ storage, analytics: interruptedAnalytics });
  first.lifecycle.begin({
    matchId: 'match-2',
    careerId: 'career-1',
    mode: 'circuits',
  });

  const ledger = JSON.parse(storage.getItem(ACTIVE_MATCH_KEY));
  assert.equal(ledger.version, 2);
  assert.deepEqual(
    ledger.matches.map(marker => marker.match_id).sort(),
    ['match-1', 'match-2'],
  );
  const firstMarker = ledger.matches.find(marker => marker.match_id === 'match-1');
  assert.equal(firstMarker.terminal_reason, 'recovered_incomplete');

  const recoveredAnalytics = new FakeAnalytics();
  const recovered = new MatchLifecycle({
    analytics: recoveredAnalytics,
    storage,
    now: () => '2026-07-24T06:02:00.000Z',
  });
  recovered.recoverIncomplete();

  const terminals = recoveredAnalytics.events.filter(event => event.type === 'match_terminal');
  assert.equal(terminals.length, 2);
  assert.deepEqual(
    terminals.map(event => event.payload.match_id).sort(),
    ['match-1', 'match-2'],
  );
  assert.equal(storage.getItem(ACTIVE_MATCH_KEY), null);
});

test('match_enter is suppressed when its recovery marker cannot be persisted', () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error('storage unavailable'); };
  const analytics = new FakeAnalytics();
  const lifecycle = new MatchLifecycle({
    analytics,
    storage,
    now: () => '2026-07-24T06:00:00.000Z',
    randomUUID: () => 'event-id',
  });

  assert.doesNotThrow(() => lifecycle.begin({
    matchId: 'unrecoverable-match',
    careerId: 'career-1',
    mode: 'circuits',
  }));
  assert.equal(analytics.events.length, 0);
});

test('terminal snapshot stays compact when optional detail is oversized', () => {
  const { lifecycle, analytics } = harness();
  const hugeFighter = {
    name: 'X'.repeat(500),
    team: 'enemy',
    alive: false,
    hp: 0,
    maxHp: 100,
    inventory: 'Y'.repeat(100_000),
  };
  lifecycle.finalize('player_win', () => ({
    ...terminalDetails(),
    final_squad: {
      player: terminalDetails().final_squad.player,
      crew: [],
      enemies: Array.from({ length: 1000 }, () => hugeFighter),
    },
  }));

  const terminal = analytics.events.find(event => event.type === 'match_terminal');
  assert.ok(JSON.stringify(terminal.payload).length < 10_000);
  assert.equal(terminal.payload.final_squad.enemies.length, 16);
  assert.equal('inventory' in terminal.payload.final_squad.enemies[0], false);
  assert.equal(terminal.payload.terminal_reason, 'player_win');
});

test('analytics exceptions cannot roll back gameplay outcome', () => {
  const { lifecycle, storage } = harness({
    analytics: new FakeAnalytics({ durable: false }),
  });
  lifecycle.analytics.throws = true;
  const match = { ended: false, won: false, endTimer: 0 };

  assert.doesNotThrow(() => markKnownOutcome(match, { won: true, endDelay: 2 },
    () => lifecycle.finalize('player_win', () => terminalDetails())));
  assert.equal(match.ended, true);
  assert.equal(match.won, true);
  assert.ok(storage.getItem(ACTIVE_MATCH_KEY));
});
