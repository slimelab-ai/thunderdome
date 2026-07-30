import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Collider } from '../src/collider.js';
import { SpectatorCamera } from '../src/spectator-camera.js';

function fakeCamera() {
  return {
    position: new THREE.Vector3(0, 0.1, 0),
    lookAt(value) { this.lastLook = value.clone(); },
  };
}

test('spectator camera snaps directly to an elevated angle on target changes', () => {
  const camera = fakeCamera();
  const spectator = new SpectatorCamera(camera, []);
  spectator.follow({ pos: new THREE.Vector3(0, 0, 0), yaw: 0, navSeed: 0 }, 1 / 60);
  assert.ok(camera.position.y > 4, 'camera never eases up from the dead player at floor level');
  assert.ok(camera.position.z < -5);
});

test('spectator camera smooths sudden fighter heading changes', () => {
  const camera = fakeCamera();
  const target = { pos: new THREE.Vector3(0, 0, 0), yaw: 0, navSeed: 0 };
  const spectator = new SpectatorCamera(camera, []);
  spectator.follow(target, 1 / 60);
  const before = camera.position.clone();
  target.yaw = Math.PI;
  spectator.follow(target, 1 / 60);
  assert.ok(camera.position.distanceTo(before) < 0.25, 'a one-frame AI turn cannot whip the camera around');
});

test('spectator camera shortens its boom before entering cover', () => {
  const camera = fakeCamera();
  const wall = new Collider(0, 3, -3, 8, 6, 0.5);
  const spectator = new SpectatorCamera(camera, [wall]);
  spectator.follow({ pos: new THREE.Vector3(0, 0, 0), yaw: 0, navSeed: 0 }, 1 / 60);
  assert.ok(camera.position.z > -2.75, 'camera remains on the target side of the wall');
});
