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
 *   2. an interruption freezes the reload rather than cancelling or finishing it
 *   3. a frozen reload survives being put away with the weapon, and resumes where it was
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
  const until = async (fn, what, ms = 8000) => {
    const t0 = Date.now();
    while (!fn() && Date.now() - t0 < ms) await step();
    if (!fn()) throw new Error(`timed out waiting for ${what}`);
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

  // 2. interrupted, not cancelled and not finished
  //
  // Pointer lock never happens headless, so the game's own tick computes `sprinting`
  // false every frame no matter what the input says. One hand-driven locked frame is
  // the only way to reach it — and it is the same `interruptReload` that healing,
  // throwing and swapping call, so this covers all four.
  pl.sprintHeld = true; pl.padMoveZ = -1;
  pl.update(1 / 60, true);
  pl.sprintHeld = false; pl.padMoveZ = 0;
  check(pl.reloadPaused, 'running did not interrupt the reload');
  check(!pl.reloadActive, 'the reload is still active after being interrupted');
  const frozenAt = pl.reloading;
  await step(30);
  check(Math.abs(pl.reloading - frozenAt) < 1e-6,
    `an interrupted reload kept running: ${frozenAt.toFixed(2)} -> ${pl.reloading.toFixed(2)}`);
  check(pl.magazineOut, 'the magazine reseated itself while the reload was interrupted');
  check(pl.roundsInWeapon === 1, 'a paused magazine change should still leave one round');

  // 3. put away and taken back out, still part done
  pl.switchTo(1);
  await until(() => pl.swapT <= 0, 'the pistol to come up');
  check(!pl.magazineOut && pl.reloading <= 0, "the pistol inherited the rifle's reload");
  pl.switchTo(0);
  await until(() => pl.swapT <= 0, 'the rifle to come back up');
  check(Math.abs(pl.reloading - frozenAt) < 1e-6,
    `the swap lost ${(frozenAt - pl.reloading).toFixed(2)} s of reload progress`);
  check(pl.reloadPaused && pl.magazineOut, 'the rifle came back out with its reload undone');

  // 4. hip fire the chambered round; the action has nothing to feed from
  pl.startReload();                                  // resume
  await until(() => pl.reloadActive, 'the reload to resume');
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
  await until(() => pl.rackT > 0, 'the rack to begin', 9000);
  check(pl.mag > magBefore, 'the fresh magazine never delivered its rounds');
  check(!pl.magazineOut, 'the rack began before the magazine was in');

  // 6. and the support hand is on the charging handle while it is worked
  const handle = pl.currentVM?.parts?.bolt;
  if (!handle) fails.push('the rifle viewmodel has no charging handle to rack');
  let grip = Infinity, travel = 0;
  const rest = handle?.userData.restZ ?? 0;
  while (pl.rackT > 0) {
    if (handle) {
      grip = Math.min(grip, fist().distanceTo(handle.getWorldPosition(new T.Vector3())));
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
