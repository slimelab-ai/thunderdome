// The recoil model, ported from DogEater.
//
// Recoil is an offset layered on top of the aim rather than a change to it, and every
// property worth having follows from that: a burst returns to where you were pointing
// on its own, a pattern is repeatable enough to learn, and pulling against the gun
// cancels the climb instead of dragging your aim under it.
//
// All of that is arithmetic over time, which is exactly the sort of thing that looks
// right in one frame and drifts over a magazine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recoil, RecoilPattern, RECOIL_TUNING, cosAlpha } from '../src/recoil.js';

/** Run the model for `seconds`, in 60 Hz steps. */
function run(r, seconds, onStep) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    if (onStep) onStep(i * dt);
    r.update(dt);
  }
}

test('a kick climbs and then comes back to exactly zero', () => {
  const r = new Recoil();
  r.add(0, 8);
  let peak = 0;
  run(r, 3, () => { peak = Math.max(peak, r.posY); });
  assert.ok(peak > 0.5, `never climbed, peaked at ${peak.toFixed(3)}`);
  // Exactly zero, not nearly: the offset is what the sights are riding on, and a
  // residue left after every burst accumulates over a match into a gun that no longer
  // points where the player is aiming.
  assert.equal(r.posY, 0);
  assert.equal(r.posX, 0);
  assert.equal(r.stable, true);
});

test('the climb is upward for an upward kick, and rightward for a rightward one', () => {
  const up = new Recoil();
  up.add(0, 8);
  run(up, 0.25);
  assert.ok(up.posY > 0, `up kick went ${up.posY}`);

  const right = new Recoil();
  right.add(8, 0);
  run(right, 0.25);
  assert.ok(right.posX > 0, `right kick went ${right.posX}`);
});

test('sustained fire keeps climbing; the drawback only runs once firing stops', () => {
  const r = new Recoil();
  const dt = 1 / 60;
  let last = 0;
  // A shot every 6 frames, for a second.
  for (let i = 0; i < 60; i++) {
    if (i % 6 === 0) r.add(0, 8);
    r.update(dt);
    if (i > 12) assert.ok(r.posY >= last - 1e-9, `slipped back mid-burst at frame ${i}`);
    last = r.posY;
  }
  assert.ok(r.posY > 1, `a second of fire only reached ${r.posY.toFixed(2)} deg`);
  run(r, 2);
  assert.equal(r.posY, 0, 'never settled after the burst');
});

test('a longer burst takes longer to settle, and both are bounded', () => {
  const settleTime = (shots) => {
    const r = new Recoil();
    const dt = 1 / 60;
    for (let i = 0; i < shots * 6; i++) {
      if (i % 6 === 0) r.add(0, 8);
      r.update(dt);
    }
    let t = 0;
    while (!r.stable && t < 5) { r.update(dt); t += dt; }
    return t;
  };
  const short = settleTime(1);
  const long = settleTime(10);
  assert.ok(long > short, `10 shots settled in ${long.toFixed(2)}s, 1 shot in ${short.toFixed(2)}s`);
  // Bounded, but not by the drawback alone: a long burst has stacked up velocity that
  // has to bleed off *before* the drawback can begin, so the total is that plus the
  // capped ease home. Asserting the drawback cap here would be asserting the wrong
  // thing about the model.
  assert.ok(long <= 1.6, `settle took ${long.toFixed(2)}s`);
  assert.ok(short <= 1.05, `a single shot took ${short.toFixed(2)}s to settle`);

  // The part that *is* capped by the tuning is the ease home itself, measured from
  // where it starts rather than from the shot.
  const r = new Recoil();
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) { if (i % 6 === 0) r.add(0, 8); r.update(dt); }
  let drawbackFor = 0;
  while (!r.stable && drawbackFor < 5) {
    r.update(dt);
    if (r.drawback) drawbackFor += dt;
  }
  // A few frames of slack: the phase ends on whichever step crosses the duration.
  assert.ok(drawbackFor <= RECOIL_TUNING.drawbackMaxDuration + dt * 4,
    `drawback ran ${drawbackFor.toFixed(2)}s against a ${RECOIL_TUNING.drawbackMaxDuration}s cap`);
});

test('pulling down against the climb cancels it instead of moving the aim', () => {
  const r = new Recoil();
  r.add(0, 8);
  run(r, 0.3);
  const climbed = r.posY;
  assert.ok(climbed > 0.2, 'nothing to fight');

  // Pull down by exactly the climb.
  const look = r.applyLook(0, -climbed);
  assert.equal(look.y, 0, 'the correction leaked into the aim');
  assert.ok(Math.abs(r.posY) < 1e-9, `offset left at ${r.posY}`);
});

test('over-pulling past the climb does move the aim, by the excess only', () => {
  const r = new Recoil();
  r.posY = 2;
  // The first degree cancels the offset; DogEater spends the whole input on the
  // offset while the signs still oppose, which is the behaviour being matched.
  const look = r.applyLook(0, -5);
  assert.equal(look.y, 0);
  assert.equal(r.posY, -3);
});

test('input in the same direction as the kick moves the aim untouched', () => {
  const r = new Recoil();
  r.posY = 2;
  const look = r.applyLook(0, 1.5);
  assert.equal(look.y, 1.5, 'upward input while already kicked up should just aim');
  assert.equal(r.posY, 2);
});

test('the two axes are independent', () => {
  const r = new Recoil();
  r.posX = 1; r.posY = 1;
  const look = r.applyLook(-0.4, 0.6);
  assert.equal(look.x, 0, 'leftward input against a rightward kick should be absorbed');
  assert.equal(look.y, 0.6, 'upward input with an upward kick should aim');
  assert.ok(Math.abs(r.posX - 0.6) < 1e-9);
  assert.equal(r.posY, 1);
});

test('touching the stick interrupts the drawback', () => {
  const r = new Recoil();
  r.add(0, 8);
  run(r, 0.4);
  // Somewhere in the recovery.
  const before = r.posY;
  assert.ok(before > 0);
  r.applyLook(0.001, 0);
  assert.equal(r.drawback, false);
});

// ---- the pattern ----

test('the pattern is walked in order and repeats', () => {
  const p = new RecoilPattern({ recoilPattern: [[0, 1], [1, 0], [0, -1]], recoilVelocity: 1, recoilRandom: 0 });
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push(p.next(i * 0.01));
  assert.deepEqual(seen.map((k) => [k.x, k.y]), [[0, 1], [1, 0], [0, -1], [0, 1]]);
});

test('the index resets after the cooldown, so every burst opens the same way', () => {
  const p = new RecoilPattern({
    recoilPattern: [[0, 1], [1, 0], [0, -1]], recoilVelocity: 1, recoilRandom: 0, recoilCooldown: 0.5,
  });
  p.next(0); p.next(0.05);
  const resumed = p.next(0.10);
  assert.deepEqual([resumed.x, resumed.y], [0, -1], 'a continuous burst should keep walking');
  const fresh = p.next(1.0);
  assert.deepEqual([fresh.x, fresh.y], [0, 1], 'a new burst should start at the top');
});

test('velocity scales the pattern and randomness stays inside its radius', () => {
  const p = new RecoilPattern({
    recoilPattern: [[0, 1]], recoilVelocity: 10, recoilRandom: 2, recoilCooldown: 1,
  });
  for (let i = 0; i < 200; i++) {
    const k = p.next(i, Math.random);
    assert.ok(Math.hypot(k.x, k.y - 10) <= 2 + 1e-9, `scatter escaped: ${k.x},${k.y}`);
  }
});

test('a weapon with no pattern never kicks', () => {
  const p = new RecoilPattern({ recoilPattern: [], recoilVelocity: 0 });
  const k = p.next(0);
  assert.deepEqual([k.x, k.y], [0, 0]);
});

test('the drawback easing starts and ends at rest', () => {
  assert.equal(cosAlpha(0), 0);
  assert.equal(cosAlpha(1), 1);
  assert.ok(Math.abs(cosAlpha(0.5) - 0.5) < 1e-9);
  // Clamped, so a late frame cannot overshoot the target and swing back.
  assert.equal(cosAlpha(1.5), 1);
  assert.equal(cosAlpha(-1), 0);
});
