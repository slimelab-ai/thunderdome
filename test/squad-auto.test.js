import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_AMMO_STACKS, nextShopCharacter, orderedSquad, planSquadAmmo, planSquadHealing,
  planSquadTraining,
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

const stash = (items = []) => ({
  cols: 10,
  rows: 0,
  items: items.map((item, index) => ({
    it: { uid: `stash-${index}`, ...item },
    x: index,
    y: 0,
  })),
});

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

test('auto-ammo fills a partial stack even when the backpack has no empty cells', () => {
  const pack = [
    { type: 'ammo_9mm', rounds: 45 },
    ...Array.from({ length: 11 }, () => ({ type: 'medkit' })),
  ];
  const plan = planSquadAmmo(
    [{ who: 'player', ch: character({ pack }) }],
    1000,
    flatQuote({ ammo_9mm: 25 }),
  );
  assert.equal(plan.purchases.length, 1);
  assert.equal(plan.purchases[0].rounds, 45);
});

test('auto-ammo pulls exact round deficits from the stash before buying boxes', () => {
  const fighter = {
    who: 'player',
    ch: character({ pack: [{ type: 'ammo_9mm', rounds: 45 }] }),
  };
  const plan = planSquadAmmo(
    [fighter],
    1000,
    flatQuote({ ammo_9mm: 25 }),
    AUTO_AMMO_STACKS,
    stash([{ type: 'ammo_9mm', rounds: 90 }]),
  );
  assert.deepEqual(plan.steps.map(step => [step.source, step.rounds]), [
    ['stash', 90],
    ['market', 45],
  ]);
  assert.equal(plan.cost, 25);
});

test('auto-ammo remains actionable at zero cost when the stash covers the refill', () => {
  const fighter = { who: 'player', ch: character({ pack: [] }) };
  const plan = planSquadAmmo(
    [fighter],
    0,
    flatQuote({ ammo_9mm: 25 }),
    AUTO_AMMO_STACKS,
    stash([{ type: 'ammo_9mm', rounds: 180 }]),
  );
  assert.equal(plan.cost, 0);
  assert.equal(plan.purchases.length, 0);
  assert.deepEqual(plan.transfers.map(step => step.rounds), [180]);
  assert.equal(plan.steps.length, 1);
});

test('auto-ammo returns ammo a fighter cannot use to the stash', () => {
  const fighter = {
    who: 'player',
    ch: character({ pack: [
      { type: 'ammo_9mm', rounds: 90 },
      { type: 'ammo_9mm', rounds: 90 },
      { type: 'ammo_762', rounds: 35 },
    ] }),
  };
  const plan = planSquadAmmo([fighter], 0, flatQuote({}));
  assert.deepEqual(plan.returns.map(step => [step.type, step.rounds]), [['ammo_762', 35]]);
  assert.deepEqual(plan.steps.map(step => step.source), ['pack']);
  assert.equal(plan.cost, 0);
});

test('auto-ammo can refill a squadmate with incompatible ammo recovered from another pack', () => {
  const fighters = [
    {
      who: 'player',
      ch: character({ pack: [
        { type: 'ammo_9mm', rounds: 90 },
        { type: 'ammo_9mm', rounds: 90 },
        { type: 'ammo_762', rounds: 60 },
      ] }),
    },
    { who: 0, ch: character({ gun1: 'rifle', pack: [] }) },
  ];
  const plan = planSquadAmmo(fighters, 0, flatQuote({ ammo_762: 95 }));
  assert.deepEqual(plan.steps.slice(0, 2).map(step => [step.source, step.who, step.rounds]), [
    ['pack', 'player', 60],
    ['stash', 0, 60],
  ]);
});

test('auto-ammo stashes compatible ammo above the per-weapon target', () => {
  const fighter = {
    who: 'player',
    ch: character({ pack: [
      { type: 'ammo_9mm', rounds: 90 },
      { type: 'ammo_9mm', rounds: 90 },
      { type: 'ammo_9mm', rounds: 45 },
    ] }),
  };
  const plan = planSquadAmmo([fighter], 0, flatQuote({}));
  assert.deepEqual(plan.returns.map(step => [step.reason, step.type, step.rounds]), [
    ['excess', 'ammo_9mm', 45],
  ]);
  assert.equal(plan.purchases.length, 0);
  assert.equal(plan.transfers.length, 0);
});

test('auto-ammo redistributes one fighter’s compatible surplus before buying more', () => {
  const fighters = [
    { who: 'player', ch: character({ pack: [
      { type: 'ammo_9mm', rounds: 90 },
      { type: 'ammo_9mm', rounds: 90 },
      { type: 'ammo_9mm', rounds: 90 },
    ] }) },
    { who: 0, ch: character({ pack: [{ type: 'ammo_9mm', rounds: 90 }] }) },
  ];
  const plan = planSquadAmmo(fighters, 0, flatQuote({ ammo_9mm: 55 }));
  assert.deepEqual(plan.steps.map(step => [step.source, step.who, step.rounds]), [
    ['pack', 'player', 90],
    ['stash', 0, 90],
  ]);
  assert.equal(plan.cost, 0);
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
