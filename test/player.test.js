import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player } from '../src/player.js';
import { createProgression, combatProfile, PLAYER_TYPE } from '../src/progression.js';

test('an untrained player starts a match with a finite camera transform', () => {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 250);
  const world = {
    colliders: [],
    combatants: [],
    hitMeshes: [],
    playerShooter: { isPlayer: true, team: 'player' },
    playerProxy: { pos: new THREE.Vector3(), alive: true, heightScale: 1 },
    fx: { tracer() {}, sparks() {} },
  };
  const player = new Player(camera, world);
  const progress = createProgression();
  player.skills = progress.skills;
  player.progressStats = combatProfile(PLAYER_TYPE, progress, true);
  player.resetForMatch(new THREE.Vector3(0, 0, 13.5));

  player.update(1 / 60, false);

  assert.ok(Number.isFinite(player.ads));
  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.ok([camera.rotation.x, camera.rotation.y, camera.rotation.z].every(Number.isFinite));
});

test('death releases the world proxy so the corpse cannot soak bullets while spectating', () => {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 250);
  const world = {
    colliders: [],
    combatants: [],
    hitMeshes: [],
    playerShooter: { isPlayer: true, team: 'player' },
    playerProxy: { pos: new THREE.Vector3(), alive: true, heightScale: 1 },
    fx: { tracer() {}, sparks() {} },
  };
  const player = new Player(camera, world);
  const progress = createProgression();
  player.skills = progress.skills;
  player.progressStats = combatProfile(PLAYER_TYPE, progress, true);
  player.resetForMatch(new THREE.Vector3(0, 0, 13.5));
  player.update(1 / 60, true);
  assert.equal(world.playerProxy.alive, true);

  player.takeDamage(10000, 'torso', new THREE.Vector3());
  assert.equal(player.alive, false);
  camera.position.set(100, 24, 100);
  player.update(1 / 60, true, true); // spectator phase keeps ticking without stealing the camera
  assert.equal(world.playerProxy.alive, false);
  assert.deepEqual(camera.position.toArray(), [100, 24, 100]);
});

test('controller look consumes recoil before moving the underlying aim', () => {
  const player = Object.assign(Object.create(Player.prototype), {
    alive: true,
    yaw: 0,
    pitch: 0,
    recoil: {
      posY: 5,
      applyLook(dx, dy) {
        const consumed = Math.min(this.posY, Math.max(0, -dy));
        this.posY -= consumed;
        return { x: dx, y: dy + consumed };
      },
    },
  });
  player.addLook(0, -2 * Math.PI / 180);
  assert.ok(Math.abs(player.recoil.posY - 3) < 1e-9);
  assert.equal(player.pitch, 0, 'down-stick correction is spent on the visible kick first');
});
