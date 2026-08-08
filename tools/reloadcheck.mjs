/**
 * reloadcheck — does a reload behave like a sequence of physical actions?
 *
 * The reload is the most intricate state machine the player owns and none of it is
 * reachable from a unit test: it lives on `Player`, it advances in the update loop, and
 * its correctness is a relationship between the magazine, the chamber, the clock and the
 * viewmodel. Every part of it has already regressed silently once — the chamber that
 * never drained, the charging handle that flew back with no hand on it — so it gets a
 * bench that drives the real player through the real loop and reads the real state.
 *
 * What it asserts, in order:
 *   1. the magazine leaves the well, and only the chambered round is available while it is
 *   2. an interruption drops back to the top of the stage and brings the weapon up ready
 *   3. the abandoned stage survives being put away with the weapon, and is redone whole
 *   4. firing the chambered round mid-change leaves the chamber dead and grows a rack
 *   5. the rack chambers a round out of the magazine and the gun works again
 *   6. the support hand is actually on the charging handle while it is worked
 *
 * Usage: npm run reloadcheck -- --url http://localhost:5173
 */
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
};
const url = arg('url', process.env.GAME_URL || 'http://localhost:5173');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// The fist has to get closer to the charging handle than this while the bolt is worked.
// At rest it sits 9-12 cm away on the handguard, so anything under 3 cm is a hand that
// has genuinely travelled to the handle rather than one waving in its general direction.
const RACK_GRIP = 0.03;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__game', { timeout: 60000 });

const report = await page.evaluate(async (RACK_GRIP) => {
  const g = window.__game;
  const T = g.THREE;
  // Not `assetsReady`: that sits behind the combat asset gate, which only a match or a
  // sandbox opens. Opening it is this bench's business, not a match's.
  await g.loadCombatAssets();
  g.sandbox(['rifle', 'pistol']);
  for (let i = 0; i < 400 && g.phase === 'loading'; i++) await new Promise((r) => setTimeout(r, 50));
  if (g.phase === 'loading') throw new Error('the sandbox never finished loading');

  const pl = g.player;
  const step = (n = 1) => new Promise((r) => setTimeout(r, n * 17));
  const state = () => `stage=${pl.reloadStage} t=${pl.reloading.toFixed(2)}/${pl.reloadDur.toFixed(2)}`
    + ` paused=${pl.reloadPaused} magOut=${pl.magazineOut} chambered=${pl.chambered}`
    + ` mag=${pl.mag} rack=${pl.rackT.toFixed(2)}`;
  /**
   * Wait for something, bounded by frames the game actually rendered.
   *
   * Not by wall-clock. The reload advances on `requestAnimationFrame`, and a headless
   * tab that loses the compositor stops rendering while the clock keeps running — so a
   * wall-clock deadline reports "the reload never finished" when what happened is that
   * the game was not running. That produced exactly one spurious failure in six runs
   * here before this. The wall-clock bound stays as a backstop for a page that has died
   * outright, set far enough out that throttling alone cannot reach it.
   */
  const until = async (fn, what, frames = 500) => {
    const f0 = window.__frames || 0;
    const t0 = Date.now();
    while (!fn() && (window.__frames || 0) - f0 < frames && Date.now() - t0 < 60000) await step();
    // Without the state dump a timeout says only that something did not happen, which is
    // the least useful half of the information.
    if (!fn()) {
      const ran = (window.__frames || 0) - f0;
      throw new Error(`timed out waiting for ${what} after ${ran} frames — ${state()}`);
    }
  };
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };
  // The fist, not the wrist — the hand bone's tail is what the IK actually aims.
  const fist = () => pl.arms.bones.get('hand_l').localToWorld(new T.Vector3(0, 0.123, 0));

  pl.switchTo(0);
  await until(() => pl.swapT <= 0, 'the rifle to come up');
  pl.mag = 8; pl.chambered = true;

  // 1. the magazine out of the well
  pl.startReload();
  await until(() => pl.magazineOut, 'the magazine to leave the well');
  check(pl.roundsInWeapon === 1,
    `magazine out but ${pl.roundsInWeapon} rounds available; only the chambered one should be`);
  check(pl.mag === 8, 'the rounds in the old magazine were destroyed rather than held');

  // 2. interrupted: back to the top of the stage, weapon up and usable
  //
  // Pointer lock never happens headless, so the game's own tick computes `sprinting`
  // false every frame no matter what the input says. One hand-driven locked frame is
  // the only way to reach it — and it is the same `interruptReload` that healing,
  // throwing and swapping call, so this covers all four.
  // Genuinely part way into the stage. `magazineOut` goes true on the *first* frame of
  // the insert, so interrupting there would rewind to where it already was and prove
  // nothing at all.
  await step(15);
  const stage = pl.reloadStage;
  const wasAt = pl.reloading;
  check(wasAt < pl.reloadDur * 0.9, 'the bench never got far enough into the stage to test it');
  pl.sprintHeld = true; pl.padMoveZ = -1;
  pl.update(1 / 60, true);
  pl.sprintHeld = false; pl.padMoveZ = 0;
  check(pl.reloadPaused, 'running did not interrupt the reload');
  check(!pl.reloadActive, 'the reload is still active after being interrupted');
  check(stage === 'insert', `interrupted during '${stage}'; this bench meant to catch the insert`);
  check(pl.reloading === pl.reloadDur,
    `left ${pl.reloading.toFixed(2)} s into a ${pl.reloadDur.toFixed(2)} s stage; should be at the top`);
  check(pl.reloading > wasAt, 'the interrupted stage was not rewound');
  await step(30);
  check(pl.reloading === pl.reloadDur, 'an interrupted reload kept running');
  // The state it leaves behind: no magazine, one round, and the hands off the reload so
  // the weapon is ready rather than frozen half way through changing it.
  check(pl.magazineOut, 'the magazine reseated itself while the reload was interrupted');
  check(pl.roundsInWeapon === 1, 'an interrupted magazine change should still leave one round');
  check(pl.arms.current === null, 'the arms are still holding the abandoned reload pose');
  check(pl.arms.rackK === 0, 'the support hand is still racking a weapon it let go of');

  // 3. put away and taken back out, with the same stage still owed
  pl.switchTo(1);
  await until(() => pl.swapT <= 0, 'the pistol to come up');
  check(!pl.magazineOut && pl.reloading <= 0, "the pistol inherited the rifle's reload");
  pl.switchTo(0);
  await until(() => pl.swapT <= 0, 'the rifle to come back up');
  check(pl.reloadStage === 'insert' && pl.magazineOut && pl.reloadPaused,
    'the rifle came back out of the holster with its magazine change forgotten');
  check(pl.reloading === pl.reloadDur, 'the stage came back part-done');

  // 4. hip fire the chambered round; the action has nothing to feed from
  pl.startReload();                                  // resume: the insert, from the top
  await until(() => pl.reloadActive, 'the reload to resume');
  check(pl.reloadStage === 'insert', `resumed into '${pl.reloadStage}' instead of the insert`);
  check(!pl.arms.current || pl.arms.current.getClip().name.startsWith('reload'),
    'resuming a reload did not put a reload clip back on the arms');
  const magBefore = pl.mag;
  pl.triggerQueued = true; pl.triggerHeld = true;
  await step(3);
  pl.triggerHeld = false;
  check(!pl.chambered, 'firing during a magazine change did not empty the chamber');
  await until(() => pl.chamberT <= 0, 'the action to cycle');
  await step(2);
  check(!pl.chambered, 'the action fed from a magazine that is out of the weapon');
  check(pl.mag === magBefore, 'the magazine lost a round while it was out of the weapon');

  // 5. the magazine seats and the rack it did not owe appears
  await until(() => pl.rackT > 0, 'the rack to begin');
  check(pl.mag > magBefore, 'the fresh magazine never delivered its rounds');
  check(!pl.magazineOut, 'the rack began before the magazine was in');

  // 6. an interrupted rack lets go of the handle, and stays let go across a swap
  //
  // It did not. `rackK` kept driving the support hand at the charging handle for as long
  // as a rack was owed, and because an owed rack survives the holster it then fought the
  // draw of whatever came up next — an arm through the receiver of a weapon that was not
  // even being reloaded.
  const handle = pl.currentVM?.parts?.bolt;
  if (!handle) fails.push('the rifle viewmodel has no charging handle to rack');
  const handlePos = () => handle.getWorldPosition(new T.Vector3());
  await step(4);                                     // let the hand get onto the handle
  pl.sprintHeld = true; pl.padMoveZ = -1;
  pl.update(1 / 60, true);
  pl.sprintHeld = false; pl.padMoveZ = 0;
  check(pl.reloadPaused && pl.rackT > 0, 'running did not interrupt the rack');
  check(pl.rackT === pl.rackDur, 'the interrupted rack was not rewound to the top');
  await step(10);
  check(pl.arms.rackK === 0, 'the support hand is still racking an abandoned rack');
  check(handle.position.z === handle.userData.restZ,
    'the charging handle is stuck out of battery with nothing working it');
  // ...and through a swap, which is where it was visible
  pl.switchTo(1);
  await until(() => pl.swapT <= 0, 'the pistol to come up');
  check(pl.arms.rackK === 0, "the pistol is being racked by the rifle's abandoned rack");
  check(pl.pumpT <= 0, 'a pump stroke followed the swap onto a weapon with no pump');
  pl.switchTo(0);
  await until(() => pl.swapT <= 0, 'the rifle to come back up');
  check(pl.rackT > 0 && pl.reloadPaused, 'the rifle forgot the rack it still owed');
  check(pl.arms.rackK === 0, 'the support arm is pinned to the bolt through the draw');

  // ...and picking it back up works the handle properly, with a hand on it
  pl.startReload();
  await until(() => pl.reloadActive, 'the rack to resume');
  let grip = Infinity, travel = 0;
  const rest = handle?.userData.restZ ?? 0;
  const rackStart = window.__frames || 0;
  while (pl.rackT > 0 && (window.__frames || 0) - rackStart < 500) {
    if (handle) {
      grip = Math.min(grip, fist().distanceTo(handlePos()));
      travel = Math.max(travel, Math.abs(handle.position.z - rest));
    }
    await step();
  }
  check(grip < RACK_GRIP, `the hand got no closer than ${(grip * 100).toFixed(1)} cm to the handle`);
  check(travel > 0.02, `the charging handle only moved ${(travel * 100).toFixed(1)} cm`);
  await step(2);
  check(pl.chambered, 'the rack did not chamber a round');
  check(pl.roundsInWeapon === pl.weapon.mag,
    `${pl.roundsInWeapon} rounds after a dry reload; expected a full magazine`);

  return { fails, grip: +grip.toFixed(4), travel: +travel.toFixed(4), rounds: pl.roundsInWeapon };
}, RACK_GRIP);

await browser.close();

console.log('\nreload: interrupt, partial state and the rack\n');
console.log(`  hand to the charging handle   ${(report.grip * 100).toFixed(1)} cm (budget ${RACK_GRIP * 100} cm)`);
console.log(`  charging handle travel        ${(report.travel * 100).toFixed(1)} cm`);
console.log(`  rounds after a dry reload     ${report.rounds}`);
console.log('  ----------------------------------------------------');
if (report.fails.length) {
  for (const f of report.fails) console.log(`  FAIL  ${f}`);
  console.log(`\n${report.fails.length} failure(s)`);
  process.exit(1);
}
console.log('\nall clean');
