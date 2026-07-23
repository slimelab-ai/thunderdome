import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIRE_TYPES, createProgression, trainingTrees, buyTraining, combatProfile,
  calculateXp, grantXp,
} from '../src/progression.js';

test('all recruit archetypes cost the same and start as sidegrades', () => {
  assert.deepEqual(new Set(Object.values(HIRE_TYPES).map(type => type.price)), new Set([400]));
  assert.ok(HIRE_TYPES.medic.archetype);
  assert.ok(HIRE_TYPES.shield.archetype);
});

test('every character gets a common and three-tier role tree', () => {
  const trees = trainingTrees('medic');
  assert.deepEqual(trees.common.map(node => node.id), ['aim', 'cardio', 'tough']);
  assert.deepEqual(trees.role.map(node => node.id), ['trauma', 'response']);
  assert.ok([...trees.common, ...trees.role].every(node => node.costs.length === 3));
});

test('training spends character XP and stops at tier three', () => {
  const progress = createProgression({}, 2000);
  for (let i = 0; i < 3; i++) assert.equal(buyTraining(progress, 'enforcer', 'aim'), true);
  assert.equal(progress.skills.aim, 3);
  assert.equal(buyTraining(progress, 'enforcer', 'aim'), false);
  assert.equal(buyTraining(progress, 'enforcer', 'trauma'), false, 'cannot buy another role tree');
});

test('training effects are reflected in combat stats', () => {
  const base = combatProfile('marksman', createProgression());
  const trained = combatProfile('marksman', createProgression({ aim: 3, tough: 3, precision: 3 }));
  assert.ok(trained.spreadMult < base.spreadMult * 0.6);
  assert.equal(trained.maxHp, base.maxHp + 45);
});

test('wins and survival independently multiply earned experience', () => {
  const stats = { damage: 100, kills: 2, headshots: 1, support: 0 };
  const loss = calculateXp(stats);
  const win = calculateXp(stats, { won: true });
  const survived = calculateXp(stats, { survived: true });
  const survivedWin = calculateXp(stats, { won: true, survived: true });
  assert.ok(win.total > loss.total);
  assert.ok(survived.total > win.total, 'survival carries the larger individual multiplier');
  assert.ok(survivedWin.total > win.total);
  const progress = createProgression();
  grantXp(progress, survivedWin.total);
  assert.equal(progress.xp, survivedWin.total);
  assert.equal(progress.totalXp, survivedWin.total);
});
