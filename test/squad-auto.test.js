import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextShopCharacter, orderedSquad, planSquadAmmo, planSquadHealing, planSquadTraining,
} from '../src/squad-auto.js';

const character = ({
  gun1 = 'pistol', gun2 = null, head = null, body = null, limbs = null, pack = [],
} = {}) => ({
  gear: {
    gun1: gun1 ? { type: gun1 } : null,
    gun2: gun2 ? { type: gun2 } : null,
    head: head ? { type: head } : null,
    body: body ? { type: body } : null,
    limbs: limbs ? { type: limbs } : null,
  },
  pack: {
    cols: 4,
    rows: 3,
    items: pack.map((item, index) => ({
      it: { uid: `pack-${index}`, ...item },
      x: index % 4,
      y: Math.floor(index / 4),
    })),
  },
});

const flatQuote = (prices) => (type, quantity) => (prices[type] ?? 100) * quantity;

test('shop character cycling wraps in either direction', () => {
  const roster = ['player', 0, 2];
  assert.equal(nextShopCharacter(roster, 'player', 1), 0);
  assert.equal(nextShopCharacter(roster, 0, -1), 'player');
  assert.equal(nextShopCharacter(roster, 2, 1), 'player');
});

test('ordered squad prioritizes the player, deployed crew, then reserves', () => {
  const career = {
    playerCh: character(),
    crew: [
      { name: 'reserve', benched: true, ch: character() },
      { name: 'active', benched: false, ch: character() },
    ],
  };
  assert.deepEqual(orderedSquad(career).map(entry => entry.who), ['player', 1, 0]);
});

test('auto-heal fully patches in order and spends the remainder on the next fighter', () => {
  const plan = planSquadHealing([
    { who: 'player', cost: 80 },
    { who: 0, cost: 100 },
    { who: 1, cost: 40 },
  ], 150);
  assert.equal(plan.cost, 150);
  assert.deepEqual(plan.steps.map(step => [step.who, step.pay, step.full]), [
    ['player', 80, true],
    [0, 70, false],
  ]);
});

test('auto-ammo targets two full stacks for every equipped weapon', () => {
  const fighter = {
    who: 'player',
    ch: character({
      gun1: 'pistol',
      gun2: 'smg',
      pack: [{ type: 'ammo_9mm', rounds: 45 }],
    }),
  };
  const plan = planSquadAmmo([fighter], 1000, flatQuote({ ammo_9mm: 25 }));
  assert.equal(plan.purchases.length, 4, 'two 9mm weapons target four stacks total');
  assert.equal(plan.cost, 100);
  assert.ok(plan.purchases.every(purchase => purchase.type === 'ammo_9mm'));
});

test('auto-ammo preserves strict roster priority when the next stack is unaffordable', () => {
  const fighters = [
    { who: 'player', ch: character() },
    { who: 0, ch: character() },
  ];
  const plan = planSquadAmmo(fighters, 25, flatQuote({ ammo_9mm: 20 }));
  assert.deepEqual(plan.purchases.map(purchase => purchase.who), ['player']);
  assert.equal(plan.cost, 20);
});

test('auto-upgrade spends each fighter’s XP on balanced stat tiers without touching gear', () => {
  const fighters = [
    {
      who: 'player',
      type: 'challenger',
      progress: { xp: 350, skills: { aim: 0, cardio: 0, tough: 0 } },
    },
    {
      who: 0,
      type: 'medic',
      progress: { xp: 100, skills: { aim: 0, cardio: 0, tough: 0 } },
    },
  ];
  const plan = planSquadTraining(fighters);
  assert.deepEqual(plan.upgrades.map(({ who, skillId, cost }) => [who, skillId, cost]), [
    ['player', 'aim', 100],
    ['player', 'cardio', 100],
    ['player', 'tough', 100],
    [0, 'aim', 100],
  ]);
  assert.equal(plan.cost, 400);
  assert.equal(fighters[0].progress.xp, 350, 'planning does not mutate live progression');
});
