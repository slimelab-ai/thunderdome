// The chambered round, ported from DogEater.
//
// The rule is one sentence — reload with rounds left and you keep the chambered one —
// and it produces two capacities, two durations and two ways to be short-changed by
// the reserve. That is exactly the shape of thing that reads as obviously correct and
// is off by one, so it lives in a pure function with a test rather than inline in the
// player's update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, planReload } from '../src/weapons.js';

const rifle = WEAPONS.rifle;

test('reloading with rounds left keeps the chambered one: mag + 1', () => {
  const p = planReload(rifle, 5, 999);
  assert.equal(p.chambered, true);
  assert.equal(p.capacity, rifle.mag + 1);
  assert.equal(p.mag, rifle.mag + 1);
  assert.equal(p.taken, rifle.mag + 1 - 5);
});

test('reloading from empty gets a full magazine and no more', () => {
  const p = planReload(rifle, 0, 999);
  assert.equal(p.chambered, false);
  assert.equal(p.capacity, rifle.mag);
  assert.equal(p.mag, rifle.mag);
});

test('an empty gun takes longer, because the bolt has to go home too', () => {
  const dry = planReload(rifle, 0, 999).duration;
  const tactical = planReload(rifle, 5, 999).duration;
  assert.ok(dry > tactical, `dry ${dry} should exceed tactical ${tactical}`);
  assert.equal(tactical, rifle.reload);
  assert.equal(dry, rifle.reloadEmpty);
});

test('reloading early is strictly better: more rounds, less time', () => {
  // The whole point of the mechanic. If either half of this fails there is no reason
  // to ever top up behind cover.
  const early = planReload(rifle, 1, 999);
  const late = planReload(rifle, 0, 999);
  assert.ok(early.mag > late.mag, 'topping up should end with more rounds');
  assert.ok(early.duration < late.duration, 'topping up should be quicker');
});

test('the reserve short-changes both paths, and never goes negative', () => {
  assert.equal(planReload(rifle, 5, 3).mag, 8);
  assert.equal(planReload(rifle, 5, 3).taken, 3);
  assert.equal(planReload(rifle, 0, 4).mag, 4);
  assert.equal(planReload(rifle, 5, 0).taken, 0);
  assert.equal(planReload(rifle, 5, -10).taken, 0, 'a negative reserve is not a refund');
});

test('a full magazine asks for nothing', () => {
  // Full *with* the chambered round — `w.mag` alone is not full for a loaded gun.
  const p = planReload(rifle, rifle.mag + 1, 999);
  assert.equal(p.taken, 0);
  assert.equal(p.mag, rifle.mag + 1);
});

test('the progression multiplier scales the duration, not the round count', () => {
  const fast = planReload(rifle, 5, 999, 0.5);
  assert.equal(fast.duration, rifle.reload * 0.5);
  assert.equal(fast.mag, planReload(rifle, 5, 999, 1).mag);
});

test('every weapon that reloads has both durations, and empty is never quicker', () => {
  for (const w of Object.values(WEAPONS)) {
    if (w.melee || !w.mag) continue;
    assert.ok(typeof w.reload === 'number' && w.reload > 0, `${w.id}: no reload time`);
    assert.ok(typeof w.reloadEmpty === 'number', `${w.id}: no reloadEmpty`);
    assert.ok(w.reloadEmpty >= w.reload, `${w.id}: empty reload is quicker than tactical`);
    assert.ok(typeof w.draw === 'number' && w.draw > 0, `${w.id}: no draw time`);
    assert.ok(typeof w.raise === 'number' && w.raise > 0, `${w.id}: no sprint raise time`);
  }
});

test('a heavier weapon is slower to bring up than a sidearm', () => {
  // Swap speed is a real cost or it is decoration; the sidearm has to be the fast one
  // or there is no reason to carry it.
  assert.ok(WEAPONS.pistol.draw < WEAPONS.rifle.draw);
  assert.ok(WEAPONS.rifle.draw < WEAPONS.dmr.draw);
  assert.ok(WEAPONS.pistol.raise < WEAPONS.dmr.raise);
});
