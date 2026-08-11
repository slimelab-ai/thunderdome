import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../tools/liquidation-sim/analyze.mjs';
import { seededRandom, simulateWar } from '../tools/liquidation-sim/simulator.mjs';

test('synthetic liquidation wars are deterministic by seed and emit full-fidelity events', () => {
  assert.equal(seededRandom(42)(), seededRandom(42)());
  const first = [];
  const second = [];
  const a = simulateWar({ seed: 42, onEvent: event => first.push(event) });
  const b = simulateWar({ seed: 42, onEvent: event => second.push(event) });
  assert.deepEqual({ ...a, warId: null }, { ...b, warId: null });
  assert.deepEqual(first.map(({ war_id, ...event }) => event), second.map(({ war_id, ...event }) => event));
  for (const type of ['war_start', 'liquidation_decision', 'combat_shot', 'combat_hit', 'combat_kill', 'round_end', 'war_end']) {
    assert.ok(first.some(event => event.event === type), `missing ${type}`);
  }
});

test('ten synthetic wars can be summarized across strategy and combat', () => {
  const events = [];
  const wars = Array.from({ length: 10 }, (_, index) =>
    simulateWar({ seed: 100 + index, onEvent: event => events.push(event) }));
  const { result, markdown } = analyze(events, wars);
  assert.equal(result.wars, 10);
  assert.equal(result.war_wins.alpha + result.war_wins.bravo, 10);
  assert.ok(result.economy.decisions > 0);
  assert.ok(result.combat.shots > result.combat.kills);
  assert.match(markdown, /Learnings/);
});
