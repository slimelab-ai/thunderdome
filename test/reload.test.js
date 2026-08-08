// The chambered round, ported from DogEater.
//
// The rule is one sentence — reload with rounds left and you keep the chambered one —
// and it produces two capacities, two durations and two ways to be short-changed by
// the reserve. That is exactly the shape of thing that reads as obviously correct and
// is off by one, so it lives in a pure function with a test rather than inline in the
// player's update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEAPONS, planReload, cycleTime, CHAMBER_LEAD, rackTime, magDropFor, stageTime,
  RELOAD_STAGES, MAG_OUT_AT,
} from '../src/weapons.js';

const rifle = WEAPONS.rifle;

test('reloading with a round up fills the magazine and keeps the chambered one', () => {
  // `mag` is the magazine alone; the chambered round sits on top of it. That is why
  // `total` is mag + 1 without anything special-casing the extra round.
  const p = planReload(rifle, 5, 999, true);
  assert.equal(p.chambered, true);
  assert.equal(p.capacity, rifle.mag);
  assert.equal(p.mag, rifle.mag);
  assert.equal(p.total, rifle.mag + 1);
  assert.equal(p.taken, rifle.mag - 5);
});

test('reloading with a dead chamber fills the magazine and nothing more', () => {
  // The bolt going home at the end of the reload strips one of these into the chamber,
  // which is what leaves a dry reload one round behind a tactical one.
  const p = planReload(rifle, 0, 999, false);
  assert.equal(p.chambered, false);
  assert.equal(p.mag, rifle.mag);
  assert.equal(p.total, rifle.mag);
});

test('an empty gun takes longer, because the bolt has to go home too', () => {
  const dry = planReload(rifle, 0, 999);
  const tactical = planReload(rifle, 5, 999);
  assert.ok(dry.time > tactical.time, `dry ${dry.time} should exceed tactical ${tactical.time}`);
  assert.equal(tactical.time, rifle.reload);
  assert.equal(dry.time, rifle.reloadEmpty);
  // The magazine change itself costs the same either way. The difference is entirely the
  // rack, which is a separate stage — that is what lets a shot fired mid-swap add one.
  assert.equal(dry.duration, tactical.duration);
  assert.equal(tactical.rack, 0);
  assert.equal(dry.rack, rackTime(rifle));
});

test('reloading early is strictly better: more rounds, less time', () => {
  // The whole point of the mechanic. If either half of this fails there is no reason
  // to ever top up behind cover.
  const early = planReload(rifle, 1, 999, true);
  const late = planReload(rifle, 0, 999, false);
  assert.ok(early.total > late.total, 'topping up should end with more rounds');
  assert.ok(early.time < late.time, 'topping up should be quicker');
});

test('the reserve short-changes both paths, and never goes negative', () => {
  assert.equal(planReload(rifle, 5, 3, true).mag, 8);
  assert.equal(planReload(rifle, 5, 3, true).taken, 3);
  assert.equal(planReload(rifle, 0, 4, false).mag, 4);
  assert.equal(planReload(rifle, 5, 0, true).taken, 0);
  assert.equal(planReload(rifle, 5, -10, true).taken, 0, 'a negative reserve is not a refund');
});

test('a full magazine asks for nothing', () => {
  const p = planReload(rifle, rifle.mag, 999, true);
  assert.equal(p.taken, 0);
  assert.equal(p.total, rifle.mag + 1);
});

test('the progression multiplier scales the duration, not the round count', () => {
  const fast = planReload(rifle, 5, 999, true, 0.5);
  assert.equal(fast.time, rifle.reload * 0.5);
  assert.equal(fast.mag, planReload(rifle, 5, 999, true, 1).mag);
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

// ---- swap timing and racking ----

test('a swap costs the outgoing holster plus the incoming draw, and is directional', () => {
  const cost = (a, b) => WEAPONS[a].holster + WEAPONS[b].draw;
  // Directional: putting a DMR away is not the same as putting a shotgun away, so the
  // two orders of the same pair differ. If they did not, `holster` would be decoration.
  assert.notEqual(cost('dmr', 'shotgun').toFixed(2), cost('shotgun', 'dmr').toFixed(2));
  // A sidearm has to be genuinely quicker to get onto a target, or there is no reason
  // to carry one once you can afford a rifle.
  assert.ok(cost('rifle', 'pistol') < cost('pistol', 'rifle'));
  assert.ok(cost('pistol', 'pistol') < cost('dmr', 'dmr'));
});

test('the swap spread is wide enough to be a decision', () => {
  const ids = ['pistol', 'smg', 'shotgun', 'rifle', 'dmr'];
  const costs = ids.flatMap((a) => ids.map((b) => WEAPONS[a].holster + WEAPONS[b].draw));
  const lo = Math.min(...costs), hi = Math.max(...costs);
  // They were all within 0.35 s of each other and read as identical. Better than twice
  // the range, or the numbers are not carrying any weight.
  assert.ok(hi / lo >= 2, `swap costs span only ${lo.toFixed(2)}–${hi.toFixed(2)} s`);
  assert.ok(lo >= 0.3, `a ${lo.toFixed(2)} s swap is effectively instant`);
  assert.ok(hi <= 1.6, `a ${hi.toFixed(2)} s swap is a punishment, not a cost`);
});

test('every magazine weapon has a rack worth watching', () => {
  // The stroke is the difference between the two reload times, so a weapon whose
  // `reloadEmpty` is not meaningfully longer than its `reload` racks in no time and the
  // player never sees the charging handle move.
  for (const w of Object.values(WEAPONS)) {
    if (w.melee || !w.mag || w.shellReload) continue;   // pump guns cycle their pump
    const rack = rackTime(w);
    assert.ok(rack >= 0.3, `${w.id}: a ${rack.toFixed(2)} s rack is over before it reads`);
    assert.ok(rack <= 0.9, `${w.id}: a ${rack.toFixed(2)} s rack is a punishment`);
    assert.ok(rack < w.reload, `${w.id}: the rack outlasts the magazine change`);
  }
});

test('the pump gun reloads shell by shell and has no rack', () => {
  // Its cycling part is the pump, worked once at the end and only from empty — there
  // is no slide to release, so a rack stage would animate nothing.
  assert.ok(WEAPONS.shotgun.shellReload > 0);
  assert.equal(rackTime(WEAPONS.shotgun), 0);
  assert.ok(WEAPONS.shotgun.pump > 0);
});

// ---- the stages of a magazine change ----

test('a magazine change splits into two stages that add up to the reload', () => {
  // The split is what makes an interruption cost a whole stage and no more, so the two
  // have to partition the reload exactly — a gap or an overlap is time the player either
  // never pays or pays twice.
  for (const w of Object.values(WEAPONS)) {
    if (w.melee || !w.mag || w.shellReload) continue;
    const total = RELOAD_STAGES.reduce((n, s) => n + stageTime(w, s), 0);
    assert.ok(Math.abs(total - w.reload) < 1e-9, `${w.id}: stages sum to ${total}, not ${w.reload}`);
    for (const s of RELOAD_STAGES) {
      assert.ok(stageTime(w, s) > 0.2, `${w.id}: the ${s} stage is too short to interrupt`);
    }
  }
});

test('the stage lengths scale with the reload multiplier', () => {
  assert.equal(stageTime(rifle, 'strip', 0.5), stageTime(rifle, 'strip') * 0.5);
  assert.equal(stageTime(rifle, 'rack', 0.5), rackTime(rifle) * 0.5);
});

test('seating the fresh magazine is the longer half', () => {
  // Getting the old one out is a flick; getting a new one out of a pouch, lined up and
  // seated is the part you can be caught doing. It is also the stage an interruption
  // leaves you standing in with an empty gun, so it should be the one that takes time.
  assert.ok(stageTime(rifle, 'insert') > stageTime(rifle, 'strip'));
});

// The drop is a continuous ramp, so its endpoints land within floating-point noise of 0
// and 1 rather than exactly on them. What matters is that it *reaches* them.
const fully = (v, msg) => assert.ok(Math.abs(v - 1) < 1e-9, `${msg} (got ${v})`);

test('the magazine is out of the well for the whole of the insert stage', () => {
  // Driven off the stage rather than off a clock, so a reload interrupted mid-insert
  // shows no magazine for as long as the player leaves it that way. A weapon that looks
  // loaded and will not feed, or the reverse, is the same bug.
  fully(magDropFor('insert', 0), 'interrupted at the top of the insert, and still loaded?');
  fully(magDropFor('insert', 0.5), 'the magazine came back mid-insert');
  assert.equal(magDropFor('insert', 1), 0, 'the magazine never went home');
  // ...and still in it for the top of the strip, which is where an interruption there
  // leaves the player: holding a full magazine, having lost only the grab.
  assert.equal(magDropFor('strip', 0), 0);
  fully(magDropFor('strip', 1), 'the old magazine never came clear of the well');
  assert.equal(magDropFor(null, 0.5), 0, 'no reload, no magazine hanging out of the gun');
});

test('the magazine travels rather than teleporting out of the well', () => {
  const mid = magDropFor('strip', 0.78);
  assert.ok(mid > 0 && mid < 1, `mid-strip should be partial, got ${mid}`);
});

// ---- the chamber cycle ----

test('the action cycles at the weapon fire rate, less the load lead', () => {
  // DogEater loads the chamber a hair before the weapon is ready again, so the round
  // is up by the time the trigger will answer. The consequence worth having is that
  // the bolt travel *is* the fire rate: nothing to keep in sync per weapon.
  for (const w of Object.values(WEAPONS)) {
    if (w.melee || !w.rpm) continue;
    assert.equal(cycleTime(w), Math.max(0, 60 / w.rpm - CHAMBER_LEAD), w.id);
    assert.ok(cycleTime(w) >= 0, `${w.id}: negative cycle`);
  }
});

test('a slow weapon visibly throws its bolt; a fast one does not', () => {
  // The DMR's cycle should be long enough to watch and the SMG's short enough to read
  // as a blur, or the animation is not carrying the fire rate.
  assert.ok(cycleTime(WEAPONS.dmr) > 0.25, 'the DMR should have a slow, readable action');
  assert.ok(cycleTime(WEAPONS.smg) < 0.08, 'the SMG should cycle too fast to follow');
  assert.ok(cycleTime(WEAPONS.dmr) > cycleTime(WEAPONS.rifle));
  assert.ok(cycleTime(WEAPONS.rifle) > cycleTime(WEAPONS.smg));
});

test('a fire rate faster than the load lead still cycles, rather than going negative', () => {
  assert.equal(cycleTime({ rpm: 6000 }), 0);
});
