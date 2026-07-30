import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpectatorCamera } from '../src/spectator-camera.js';

function fakeCamera() {
  return {
    position: new THREE.Vector3(0, 0.1, 0),
    fov: 75,
    projectionUpdates: 0,
    updateProjectionMatrix() { this.projectionUpdates++; },
    lookAt(value) { this.lastLook = value.clone(); },
  };
}

const fighter = (x, y, z, team = 'player', navSeed = 0) => ({
  pos: new THREE.Vector3(x, y, z),
  team,
  navSeed,
  yaw: 0,
  alive: true,
});

test('spectator camera begins five to ten feet above the selected fighter’s head', () => {
  const camera = fakeCamera();
  const target = fighter(0, 2, 0);
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60, [target]);
  assert.equal(camera.position.y, 6.4);
  assert.equal(camera.fov, 70);
  assert.ok(camera.position.distanceTo(target.pos) < 9);
});

test('camera sets its angle behind the selected fighter relative to nearby action', () => {
  const camera = fakeCamera();
  const target = fighter(0, 0, 0);
  const opponent = fighter(8, 0, 0, 'enemy');
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60, [target, opponent]);
  assert.ok(camera.position.x < -5, 'camera sits behind the fighter with the opponent ahead');
  assert.ok(camera.lastLook.x > 0, 'framing looks slightly into the play');
});

test('sub-frame target jitter is strongly smoothed instead of shaking the shot', () => {
  const camera = fakeCamera();
  const target = fighter(0, 0, 0);
  const opponent = fighter(8, 0, 0, 'enemy');
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60, [target, opponent]);
  const before = camera.position.clone();
  target.pos.set(0.25, 0, -0.2);
  spectator.follow(target, 1 / 60, [target, opponent]);
  assert.ok(camera.position.distanceTo(before) < 0.08);
});

test('switching characters creates a fast move to a genuinely different angle', () => {
  const camera = fakeCamera();
  const first = fighter(-8, 0, 0, 'player', 0);
  const second = fighter(8, 0, 0, 'player', 1);
  const opponent = fighter(0, 0, -4, 'enemy');
  const spectator = new SpectatorCamera(camera);
  spectator.follow(first, 1 / 60, [first, second, opponent]);
  const before = camera.position.clone();
  for (let i = 0; i < 20; i++) spectator.follow(second, 1 / 60, [first, second, opponent]);
  assert.ok(camera.position.distanceTo(before) > 8);
  assert.ok(camera.position.y >= 4.4 && camera.position.y <= 5);
});
