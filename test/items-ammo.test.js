import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addAmmoToPack, ammoInGrid, makeCharacter, makeItem, takeAmmoFromGrid,
} from '../src/items.js';

test('adding ammo tops partial backpack stacks before using empty cells', () => {
  const ch = makeCharacter();
  const partial = makeItem('ammo_9mm');
  partial.rounds = 45;
  ch.pack.items.push({ it: partial, x: 0, y: 0 });

  assert.equal(addAmmoToPack(ch, '9mm', 60), 60);
  assert.equal(ch.pack.items.length, 2);
  assert.equal(ch.pack.items[0].it.rounds, 90);
  assert.equal(ch.pack.items[1].it.rounds, 15);
});

test('stash ammo can be removed by exact round count across partial boxes', () => {
  const first = makeItem('ammo_9mm');
  first.rounds = 20;
  const second = makeItem('ammo_9mm');
  second.rounds = 50;
  const grid = {
    cols: 10,
    rows: 0,
    items: [{ it: first, x: 0, y: 0 }, { it: second, x: 1, y: 0 }],
  };

  assert.equal(takeAmmoFromGrid(grid, '9mm', 45), 45);
  assert.equal(ammoInGrid(grid, '9mm'), 25);
  assert.equal(grid.items.length, 1);
});
