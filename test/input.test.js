import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { stickCurve, InputHub, AIM_ASSIST, STICK } from '../src/input.js';

test('stick curve: deadzone zeroes, full deflection passes through', () => {
  assert.deepEqual(stickCurve(0.05, 0.05, STICK.deadzone, STICK.expo).mag, 0);
  const full = stickCurve(1, 0, STICK.deadzone, STICK.expo);
  assert.ok(Math.abs(full.x - 1) < 1e-9);
  assert.equal(full.y, 0);
});

test('stick curve is exponential: half deflection gives much less than half output', () => {
  const dz = STICK.deadzone;
  const halfIn = dz + (1 - dz) * 0.5; // 50% past the deadzone
  const out = stickCurve(halfIn, 0, dz, 2.0);
  assert.ok(Math.abs(out.x - 0.25) < 1e-9, `expected 0.25, got ${out.x}`);
  // and it preserves direction radially
  const diag = stickCurve(halfIn, halfIn, dz, 2.0);
  assert.ok(Math.abs(diag.x - diag.y) < 1e-9);
});

function makeHub({ enemies = [], colliders = [] } = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.62, 0); // default camera faces -Z, same as yaw 0
  camera.updateMatrixWorld();
  const player = {
    yaw: 0, pitch: 0, ads: 0, alive: true,
    triggerHeld: false, adsHeld: false, keys: {},
    padMoveX: 0, padMoveZ: 0, sprintHeld: false,
    addLook(dYaw, dPitch) { this.yaw += dYaw; this.pitch += dPitch; },
  };
  const world = { combatants: enemies, colliders };
  return { hub: new InputHub(player, world, camera), player, camera };
}

const enemyAt = (x, y, z, team = 'enemy') => ({
  alive: true, team,
  aimPoint(out = new THREE.Vector3()) { return out.set(x, y, z); },
});

test('aim assist targets an enemy near the crosshair and applies friction', () => {
  const { hub } = makeHub({ enemies: [enemyAt(0.8, 1.62, -12)] });
  const target = hub._assistTarget();
  assert.ok(target, 'enemy inside the slow cone should be targeted');
  assert.ok(target.ang < AIM_ASSIST.gamepad.slowCone);
  const mult = hub._friction(target, AIM_ASSIST.gamepad);
  assert.ok(mult < 1 && mult >= AIM_ASSIST.gamepad.friction - 1e-9);
  // no target → no slowdown
  assert.equal(hub._friction(null, AIM_ASSIST.gamepad), 1);
});

test('aim assist ignores far, off-cone, friendly, and occluded enemies', () => {
  const offCone = makeHub({ enemies: [enemyAt(12, 1.62, -12)] });
  assert.equal(offCone.hub._assistTarget(), null);

  const tooFar = makeHub({ enemies: [enemyAt(0, 1.62, -(AIM_ASSIST.range + 10))] });
  assert.equal(tooFar.hub._assistTarget(), null);

  const friendly = makeHub({ enemies: [enemyAt(0.5, 1.62, -10, 'player')] });
  assert.equal(friendly.hub._assistTarget(), null);

  const wall = { raycast: () => 3 }; // everything is behind a wall 3m out
  const occluded = makeHub({ enemies: [enemyAt(0.5, 1.62, -10)], colliders: [wall] });
  assert.equal(occluded.hub._assistTarget(), null);
});

test('rotational pull rotates the view toward the target, capped per frame', () => {
  const { hub, player } = makeHub({ enemies: [enemyAt(0.5, 1.62, -12)] });
  const target = hub._assistTarget();
  assert.ok(target);
  hub._applyPull(target, AIM_ASSIST.gamepad, 1 / 60);
  // enemy is to the right of center (-Z forward, +X right) → yaw decreases
  assert.ok(player.yaw < 0, `yaw should pull right (negative), got ${player.yaw}`);
  assert.ok(Math.abs(player.yaw) <= AIM_ASSIST.pullMaxRate / 60 + 1e-9);
  // pulling repeatedly converges instead of overshooting
  let last = Math.abs(hub._assistTarget().ang);
  for (let i = 0; i < 30; i++) {
    const t = hub._assistTarget();
    if (!t) break;
    hub._applyPull(t, AIM_ASSIST.gamepad, 1 / 60);
    hub.camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    hub.camera.updateMatrixWorld();
    const now = hub._assistTarget()?.ang ?? 0;
    assert.ok(now <= last + 1e-9, 'angular error must not grow');
    last = now;
  }
});

test('gamepad update wires buttons, movement, and pause edges into the player', () => {
  const calls = [];
  const { hub, player } = makeHub();
  player.onMouseDown = (b) => calls.push(`down${b}`);
  player.onMouseUp = (b) => calls.push(`up${b}`);
  player.onKey = (c, d) => calls.push(`key:${c}:${d}`);
  player.onWheel = () => calls.push('wheel');
  player.startReload = () => calls.push('reload');
  player.throwGrenade = () => calls.push('nade');
  player.startHeal = (k) => calls.push(`heal:${k}`);
  player.drawKnife = () => calls.push('knife');
  let paused = 0;
  hub.onPause = () => paused++;

  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  hub._pad = () => pad;

  const dt = 1 / 60;
  hub.update(dt, 'match');
  assert.equal(calls.length, 0);

  // half-forward stick moves at reduced (exponential) intent
  pad.axes[0] = 0; pad.axes[1] = -1;
  hub.update(dt, 'match');
  assert.ok(player.padMoveZ < -0.99, 'full forward = full intent');
  pad.axes[1] = -0.56;
  hub.update(dt, 'match');
  assert.ok(player.padMoveZ > -0.35 && player.padMoveZ < -0.15, `expo'd partial intent, got ${player.padMoveZ}`);
  pad.axes[1] = 0;

  // RT fire press/release edges
  buttons[7].value = 1; buttons[7].pressed = true;
  hub.update(dt, 'match');
  buttons[7].value = 0; buttons[7].pressed = false;
  hub.update(dt, 'match');
  assert.deepEqual(calls, ['down0', 'up0']);
  calls.length = 0;

  // Y swaps, X reloads, RB throws, d-pad up heals — each fires once per press
  for (const [idx, expect] of [[3, 'wheel'], [2, 'reload'], [5, 'nade'], [12, 'heal:medkit']]) {
    buttons[idx].pressed = true; buttons[idx].value = 1;
    hub.update(dt, 'match');
    hub.update(dt, 'match'); // held — no repeat
    buttons[idx].pressed = false; buttons[idx].value = 0;
    hub.update(dt, 'match');
    assert.deepEqual(calls, [expect], `button ${idx}`);
    calls.length = 0;
  }

  // Start pauses in match, resumes from pause
  buttons[9].pressed = true; buttons[9].value = 1;
  hub.update(dt, 'match');
  assert.equal(paused, 1);
  buttons[9].pressed = false; buttons[9].value = 0;
  hub.update(dt, 'paused');
  let resumed = 0;
  hub.onResume = () => resumed++;
  buttons[9].pressed = true; buttons[9].value = 1;
  hub.update(dt, 'paused');
  assert.equal(resumed, 1);
});

test('looking with the right stick turns the view and aim assist slows it near a target', () => {
  const enemies = [enemyAt(0.5, 1.62, -12)];
  const clean = makeHub();           // no enemies
  const assisted = makeHub({ enemies });
  const dt = 1 / 60;
  for (const { hub, player } of [clean, assisted]) {
    player.onMouseDown = () => {}; player.onMouseUp = () => {};
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    hub._pad = () => ({ connected: true, mapping: 'standard', axes: [0, 0, 1, 0], buttons });
    hub.gamepadActiveAt = performance.now() / 1000; // recently active
    hub.update(dt, 'match');
  }
  assert.ok(clean.player.yaw < 0, 'stick right turns right');
  assert.ok(Math.abs(assisted.player.yaw) < Math.abs(clean.player.yaw),
    `friction should slow the turn: ${assisted.player.yaw} vs ${clean.player.yaw}`);
});

test('controller look settings govern turn speed and keep default magnetism subtle', () => {
  const { hub, player } = makeHub();
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  hub._pad = () => ({ connected: true, mapping: 'standard', axes: [0, 0, 1, 0], buttons });
  hub.setControllerSettings({ sensitivity: 0.5, exponent: 1, aimAssist: 0.35 });
  hub.update(1 / 60, 'match');
  assert.ok(Math.abs(player.yaw + STICK.yawRate * 0.5 / 60) < 1e-9);

  const centered = { ang: 0 };
  const friction = hub._friction(centered, AIM_ASSIST.gamepad, hub.controllerSettings.aimAssist);
  assert.ok(friction > 0.9, `default slowdown should be mild, got ${friction}`);

  const before = player.yaw;
  hub._applyPull({ point: new THREE.Vector3(1, 1.62, -12) }, AIM_ASSIST.gamepad, 1 / 60, 0);
  assert.equal(player.yaw, before, 'zero magnetism must not rotate the player');
});

test('aim magnetism never steers an idle crosshair just because fire or ADS is held', () => {
  const { hub, player } = makeHub({ enemies: [enemyAt(0.35, 1.62, -12)] });
  player.onMouseDown = () => {};
  player.onMouseUp = () => {};
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  buttons[7] = { pressed: true, value: 1 };
  buttons[6] = { pressed: true, value: 1 };
  hub._pad = () => ({ connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons });
  hub.setControllerSettings({ aimAssist: 1 });
  hub.update(1 / 60, 'match');
  assert.equal(player.yaw, 0);
  assert.equal(player.pitch, 0);
});

test('while dead, d-pad and bumpers cycle spectator targets instead of gameplay actions', () => {
  const { hub, player } = makeHub();
  player.alive = false;
  const cycles = [];
  hub.onCycleSpectator = (dir) => cycles.push(dir);
  player.throwGrenade = () => { throw new Error('gameplay action fired while dead'); };
  player.drawKnife = () => { throw new Error('gameplay action fired while dead'); };

  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  hub._pad = () => pad;
  const dt = 1 / 60;

  for (const [idx, dir] of [[15, 1], [14, -1], [5, 1], [4, -1]]) { // DRIGHT, DLEFT, RB, LB
    buttons[idx].pressed = true; buttons[idx].value = 1;
    hub.update(dt, 'match');
    hub.update(dt, 'match'); // held — no repeat
    buttons[idx].pressed = false; buttons[idx].value = 0;
    hub.update(dt, 'match');
    assert.deepEqual(cycles, [dir], `button ${idx}`);
    cycles.length = 0;
  }
});

test('outside combat, controller inputs drive UI navigation with held-stick repeat', () => {
  const { hub } = makeHub();
  const actions = [];
  let controllerActivations = 0;
  hub.onMenuInput = (action) => actions.push(action);
  hub.onControllerActive = () => controllerActivations++;
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  hub._pad = () => pad;

  pad.axes[1] = 0.8;
  hub.update(1 / 60, 'menu');
  hub.update(1 / 60, 'menu');
  assert.deepEqual(actions, ['down'], 'initial stick deflection moves once');
  hub.update(0.35, 'menu');
  assert.deepEqual(actions, ['down', 'down'], 'held stick repeats after the navigation delay');

  pad.axes[1] = 0;
  hub.update(1 / 60, 'menu');
  pad.axes[0] = 0.8;
  hub.update(1 / 60, 'shop');
  assert.equal(actions.at(-1), 'right', 'horizontal left-stick input navigates menus');
  pad.axes[0] = 0;
  hub.update(1 / 60, 'shop');
  pad.axes[0] = -0.8;
  hub.update(1 / 60, 'shop');
  assert.equal(actions.at(-1), 'left', 'horizontal left-stick input navigates both directions');
  pad.axes[0] = 0;
  hub.update(1 / 60, 'shop');

  for (const [index, action] of [
    [0, 'activate'], [1, 'back'], [2, 'alternate'],
    [4, 'previousTab'], [5, 'nextTab'], [6, 'nextPanel'], [7, 'previousPanel'],
    [9, 'advance'],
  ]) {
    buttons[index].pressed = true;
    buttons[index].value = 1;
    hub.update(1 / 60, 'shop');
    buttons[index].pressed = false;
    buttons[index].value = 0;
    hub.update(1 / 60, 'shop');
    assert.equal(actions.at(-1), action);
  }

  buttons[3].pressed = true;
  buttons[3].value = 1;
  hub.update(0.2, 'shop');
  buttons[3].pressed = false;
  buttons[3].value = 0;
  hub.update(1 / 60, 'shop');
  assert.notEqual(actions.at(-1), 'patch', 'tapping Y is intentionally unbound');

  buttons[3].pressed = true;
  buttons[3].value = 1;
  hub.update(0.3, 'shop');
  hub.update(0.3, 'shop');
  assert.equal(actions.at(-1), 'sell', 'holding Y sells once');
  const sellCount = actions.filter(action => action === 'sell').length;
  hub.update(0.6, 'shop');
  assert.equal(actions.filter(action => action === 'sell').length, sellCount, 'continued hold does not repeat');
  buttons[3].pressed = false;
  buttons[3].value = 0;
  hub.update(1 / 60, 'shop');
  assert.equal(actions.at(-1), 'sell', 'releasing after a hold does not patch');

  buttons[12].pressed = true;
  buttons[12].value = 1;
  hub.update(1 / 60, 'shop');
  assert.equal(actions.at(-1), 'patch', 'D-pad Up patches in the market');
  buttons[12].pressed = false;
  buttons[12].value = 0;
  hub.update(1 / 60, 'shop');

  const actionCount = actions.length;
  for (const index of [13, 14, 15]) {
    buttons[index].pressed = true;
    buttons[index].value = 1;
    hub.update(1 / 60, 'shop');
    buttons[index].pressed = false;
    buttons[index].value = 0;
    hub.update(1 / 60, 'shop');
  }
  assert.equal(actions.length, actionCount, 'the rest of the D-pad is inert in menus');
  assert.ok(controllerActivations > 0, 'using the pad should reveal controller-only prompts');
});
