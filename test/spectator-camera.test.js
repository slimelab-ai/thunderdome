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

const fighter = (x, y, z) => ({
  pos: new THREE.Vector3(x, y, z),
  alive: true,
});

test('spectator camera uses a fixed high world-space aerial position', () => {
  const camera = fakeCamera();
  const target = fighter(0, -50, 0);
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60);
  assert.equal(camera.position.y, 24, 'bad target height cannot drag the camera to the floor');
  assert.equal(camera.fov, 64);
  assert.equal(camera.projectionUpdates, 1);
});

test('target animation jitter inside the broadcast dead zone cannot shake the camera', () => {
  const camera = fakeCamera();
  const target = fighter(0, 0, 0);
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60);
  const beforePosition = camera.position.clone();
  const beforeLook = camera.lastLook.clone();
  for (const [x, z] of [[0.2, -0.1], [-0.3, 0.25], [0.15, 0.4], [-0.2, -0.35]]) {
    target.pos.x = x;
    target.pos.z = z;
    spectator.follow(target, 1 / 60);
  }
  assert.ok(camera.position.distanceTo(beforePosition) < 0.001);
  assert.ok(camera.lastLook.distanceTo(beforeLook) < 0.001);
});

test('camera pans only after the fighter exits the wide aerial frame', () => {
  const camera = fakeCamera();
  const target = fighter(0, 0, 0);
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60);
  target.pos.x = 10;
  spectator.follow(target, 1);
  assert.ok(camera.position.x > 6);
  assert.equal(camera.position.y, 24);
  assert.ok(camera.lastLook.x > 5);
});

test('switching characters immediately cuts the aerial camera to the new fighter', () => {
  const camera = fakeCamera();
  const first = fighter(-10, 0, 0);
  const second = fighter(10, 0, 0);
  const spectator = new SpectatorCamera(camera);
  spectator.follow(first, 1 / 60);
  const before = camera.position.clone();
  spectator.reset();
  spectator.follow(second, 1 / 60);
  assert.ok(camera.position.distanceTo(before) > 15);
  assert.ok(camera.lastLook.x > 9);
});
