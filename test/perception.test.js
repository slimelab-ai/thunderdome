import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContactMemory, contactRadius, contactConfidence, contactLost, withinVision,
  worthGrenading, broadcastNoise, clampToArena,
  UNCERTAINTY_GROWTH, LOST_RADIUS, NOISE, INTEL, GRENADE_MAX_AGE,
} from '../src/perception.js';

const enemy = (name = 'MARK', pos = { x: 0, y: 0, z: 0 }) => ({ name, alive: true, pos });

// A rng that walks a fixed script, so "random" scatter is exact in assertions.
const scripted = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('a sighting is exact and a broken sightline freezes the last-known position', () => {
  const memory = new ContactMemory();
  const mark = enemy();

  memory.see(mark, { x: 4, y: 0, z: 4 }, 0);
  const contact = memory.get(mark);
  assert.equal(contact.visible, true);
  assert.deepEqual([contact.x, contact.z], [4, 4]);
  assert.equal(contactRadius(contact, 0), 0);

  // He walks away behind cover. The belief must not follow him.
  mark.pos = { x: 12, y: 0, z: -3 };
  memory.markUnseen(mark, 1);
  assert.equal(contact.visible, false);
  assert.deepEqual([contact.x, contact.z], [4, 4]);
  assert.equal(contact.lostSightAt, 1);
});

test('uncertainty grows with time and the contact is eventually lost', () => {
  const memory = new ContactMemory();
  const mark = enemy();
  memory.see(mark, { x: 0, y: 0, z: 0 }, 0);
  const contact = memory.markUnseen(mark, 0);

  assert.equal(contactRadius(contact, 4), 4 * UNCERTAINTY_GROWTH);
  assert.ok(contactConfidence(contact, 6) < contactConfidence(contact, 1));
  assert.equal(contactLost(contact, 4), false);

  const wide = LOST_RADIUS / UNCERTAINTY_GROWTH + 1;
  assert.equal(contactLost(contact, wide), true);
  assert.deepEqual(memory.tick(wide).map(c => c.entity), [mark]);
  assert.equal(memory.get(mark), null);
});

test('a dead enemy stops being a contact', () => {
  const memory = new ContactMemory();
  const mark = enemy();
  memory.see(mark, { x: 1, y: 0, z: 1 }, 0);
  mark.alive = false;
  memory.tick(0.1);
  assert.equal(memory.get(mark), null);
});

test('a noise lands a wrong position, and gets wronger with distance', () => {
  // rng script: angle fraction 0 (due +x), radius fraction 1 (the full error).
  const near = new ContactMemory({ rng: scripted(0, 1) });
  const far = new ContactMemory({ rng: scripted(0, 1) });
  const mark = enemy();

  near.hear(mark, { x: 0, y: 0, z: 0 }, 'gunshot', { x: 0, y: 0, z: 5 }, 0);
  far.hear(mark, { x: 0, y: 0, z: 0 }, 'gunshot', { x: 0, y: 0, z: 40 }, 0);

  const spec = NOISE.gunshot;
  assert.equal(near.get(mark).error, spec.error + 5 * spec.errorPerMetre);
  assert.equal(far.get(mark).error, spec.error + 40 * spec.errorPerMetre);
  // The recorded point is displaced by the full error, not centred on the truth.
  assert.ok(far.get(mark).x > near.get(mark).x);
  assert.equal(near.get(mark).visible, false);
  assert.equal(near.get(mark).kind, 'sound');
});

test('a noise out of earshot is not heard at all', () => {
  const memory = new ContactMemory();
  const mark = enemy();
  const listener = { x: 0, y: 0, z: NOISE.sprint.range + 1 };
  assert.equal(memory.hear(mark, { x: 0, y: 0, z: 0 }, 'sprint', listener, 0), null);
  assert.equal(memory.size, 0);
});

test('a noise never overwrites a belief that is already tighter', () => {
  const memory = new ContactMemory({ rng: scripted(0, 1) });
  const mark = enemy();
  memory.see(mark, { x: 3, y: 0, z: 3 }, 0);
  memory.markUnseen(mark, 0);

  // Half a second later the fix is still good to well under a metre.
  memory.hear(mark, { x: 20, y: 0, z: 20 }, 'gunshot', { x: 0, y: 0, z: 0 }, 0.5);
  assert.deepEqual([memory.get(mark).x, memory.get(mark).z], [3, 3]);

  // Ten seconds later it is not, and the gunshot wins.
  memory.hear(mark, { x: 20, y: 0, z: 20 }, 'gunshot', { x: 0, y: 0, z: 0 }, 10);
  assert.ok(memory.get(mark).x > 10);
});

test('squad intel arrives late, degraded, and timestamped when it was called', () => {
  const caller = { perception: new ContactMemory({ rng: () => 0.5 }) };
  const mate = { perception: new ContactMemory({ rng: () => 0 }) };
  const mark = enemy();

  caller.perception.see(mark, { x: 6, y: 0, z: -2 }, 10);
  assert.equal(caller.perception.share(mark, 10, [caller, mate]), 1);
  // Calling it twice in quick succession is one call, not two.
  assert.equal(caller.perception.share(mark, 10.4, [caller, mate]), 0);

  // Nothing arrives before the comms delay.
  mate.perception.tick(10 + INTEL.delay - 0.01);
  assert.equal(mate.perception.get(mark), null);

  mate.perception.tick(10 + INTEL.delay + INTEL.jitter);
  const shared = mate.perception.get(mark);
  assert.equal(shared.kind, 'shared');
  assert.equal(shared.error, INTEL.error);
  assert.equal(shared.confidence, INTEL.confidence);
  // Aged from when the caller saw it, so the delay is real staleness.
  assert.equal(shared.t, 10);
  assert.equal(shared.visible, false);
});

test('intel never talks a fighter out of what he can see himself', () => {
  const caller = { perception: new ContactMemory() };
  const mate = { perception: new ContactMemory() };
  const mark = enemy();

  caller.perception.see(mark, { x: 20, y: 0, z: 20 }, 0);
  caller.perception.share(mark, 0, [caller, mate]);
  mate.perception.see(mark, { x: 1, y: 0, z: 1 }, 0.5);
  mate.perception.tick(5);

  assert.equal(mate.perception.get(mark).kind, 'visual');
  assert.deepEqual([mate.perception.get(mark).x, mate.perception.get(mark).z], [1, 1]);
});

test('vision has a blind arc behind, which proximity overrides', () => {
  const at = { x: 0, y: 0, z: 0 };
  // yaw 0 faces +z.
  assert.equal(withinVision(at, 0, { x: 0, y: 0, z: 20 }), true);
  assert.equal(withinVision(at, 0, { x: 20, y: 0, z: 0 }), true);   // dead abeam, inside 100°
  assert.equal(withinVision(at, 0, { x: 0, y: 0, z: -20 }), false); // directly behind
  assert.equal(withinVision(at, 0, { x: 0, y: 0, z: -2 }), true);   // ...but not at arm's length
  assert.equal(withinVision(at, 0, { x: 0, y: 0, z: 500 }), false); // beyond sight range
});

test('a grenade needs a recent sighting or a tight fix, not a live transform', () => {
  const memory = new ContactMemory({ rng: () => 0 });
  const mark = enemy();

  memory.see(mark, { x: 0, y: 0, z: 0 }, 0);
  memory.markUnseen(mark, 0);
  assert.equal(worthGrenading(memory.get(mark), 2), true);
  assert.equal(worthGrenading(memory.get(mark), GRENADE_MAX_AGE + 1), false);
  assert.equal(worthGrenading(null, 0), false);

  // A gunshot heard from 40 m is a neighbourhood, not a target.
  const vague = new ContactMemory({ rng: () => 0 });
  vague.hear(mark, { x: 0, y: 0, z: 0 }, 'gunshot', { x: 0, y: 0, z: 40 }, 0);
  assert.equal(worthGrenading(vague.get(mark), 0), false);
});

test('the best contact is the one in view, with the player worth going after', () => {
  const memory = new ContactMemory();
  const from = { x: 0, y: 0, z: 0 };
  const seen = enemy('SEEN', { x: 25, y: 0, z: 0 });
  const heard = enemy('HEARD', { x: 3, y: 0, z: 0 });

  memory.see(seen, seen.pos, 0);
  memory.hear(heard, heard.pos, 'gunshot', from, 0);
  assert.equal(memory.best(0, { from }).entity, seen, 'in view beats close but unseen');

  const player = { name: 'YOU', alive: true, isPlayer: true, pos: { x: 26, y: 0, z: 0 } };
  const bot = enemy('BOT', { x: 24, y: 0, z: 0 });
  const race = new ContactMemory();
  race.see(player, player.pos, 0);
  race.see(bot, bot.pos, 0);
  assert.equal(race.best(0, { from }).entity, player, 'a slightly further player still wins');
});

test('noise reaches hostiles in earshot and nobody on your own side', () => {
  const shooter = { team: 'enemy', alive: true, pos: { x: 0, y: 0, z: 0 } };
  const listeners = [
    { team: 'player', alive: true, pos: { x: 0, y: 0, z: 5 } },
    { team: 'player', alive: true, pos: { x: 0, y: 0, z: 200 } },  // too far
    { team: 'enemy', alive: true, pos: { x: 0, y: 0, z: 5 } },     // his own squad
    { team: 'player', alive: false, pos: { x: 0, y: 0, z: 5 } },   // dead
  ];
  for (const l of listeners) {
    l.perception = new ContactMemory({ owner: l });
    l.hearNoise = (source, pos, kind, now) => l.perception.hear(source, pos, kind, l.pos, now);
  }
  const world = { combatants: [shooter, ...listeners] };

  assert.equal(broadcastNoise(world, shooter, shooter.pos, 'gunshot', 0), 1);
  assert.equal(listeners[0].perception.size, 1);
  assert.equal(listeners[1].perception.size, 0);
  assert.equal(listeners[2].perception.size, 0);
  assert.equal(listeners[3].perception.size, 0);
});

test('an unowned bang is a place to look, not a fix on anyone', () => {
  const bot = { team: 'enemy', alive: true, pos: { x: 0, y: 0, z: 0 } };
  bot.perception = new ContactMemory({ owner: bot });
  bot.hearNoise = () => null;
  const world = { combatants: [bot] };

  broadcastNoise(world, null, { x: 7, y: 0, z: 7 }, 'explosion', 3);
  assert.equal(bot.perception.size, 0);
  assert.deepEqual(
    [bot.perception.disturbance.x, bot.perception.disturbance.z, bot.perception.disturbance.t],
    [7, 7, 3],
  );

  bot.perception.tick(12);   // disturbances go stale too
  assert.equal(bot.perception.disturbance, null);
});

test('beliefs are clamped back inside the pit', () => {
  assert.deepEqual(clampToArena({ x: 90, y: 2, z: -90 }), { x: 20, y: 2, z: -14.5 });
});
