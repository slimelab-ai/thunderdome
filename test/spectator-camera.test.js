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

const fighter = (x, y, z, team = 'player') => ({
  pos: new THREE.Vector3(x, y, z),
  team,
  alive: true,
});

test('spectator camera snaps directly into a high aerial view', () => {
  const camera = fakeCamera();
  const target = fighter(0, 0, 0);
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60, [target]);
  assert.ok(camera.position.y >= 14, 'camera starts above the arena instead of near the corpse');
  assert.equal(camera.fov, 60);
  assert.equal(camera.projectionUpdates, 1);
});

test('aerial camera ignores fighter yaw and remains stable while they turn', () => {
  const camera = fakeCamera();
  const target = fighter(0, 0, 0);
  target.yaw = 0;
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60, [target]);
  const before = camera.position.clone();
  target.yaw = Math.PI;
  spectator.follow(target, 1 / 60, [target]);
  assert.ok(camera.position.distanceTo(before) < 0.001);
});

test('aerial framing includes the selected fighter’s nearest opponent', () => {
  const camera = fakeCamera();
  const target = fighter(0, 0, 0);
  const nearEnemy = fighter(10, 0, 0, 'enemy');
  const farEnemy = fighter(-30, 0, 0, 'enemy');
  const spectator = new SpectatorCamera(camera);
  spectator.follow(target, 1 / 60, [target, nearEnemy, farEnemy]);
  assert.ok(camera.lastLook.x > 2 && camera.lastLook.x < 4);
  assert.ok(camera.position.y > 13, 'camera gains altitude to keep the engagement visible');
});

test('switching characters immediately moves the aerial camera to the new fighter', () => {
  const camera = fakeCamera();
  const first = fighter(-10, 0, 0);
  const second = fighter(10, 0, 0);
  const spectator = new SpectatorCamera(camera);
  spectator.follow(first, 1 / 60, [first, second]);
  const before = camera.position.clone();
  spectator.reset();
  spectator.follow(second, 1 / 60, [first, second]);
  assert.ok(camera.position.distanceTo(before) > 15, 'switching is an obvious cut, not an imperceptible drift');
  assert.ok(camera.lastLook.x > 9);
});
