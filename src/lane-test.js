import * as THREE from 'three';
import { Collider } from './collider.js';

/**
 * A purpose-built pit for one question: does a squad walk into a held lane?
 *
 * The real arena is a fine place to play and a poor place to measure. It is full of
 * props, cover at every angle and half a dozen ways through, so a squad that avoids
 * a lane and a squad that never had reason to go near it produce the same number,
 * and any result is an argument about which. This map removes the argument.
 *
 * Looking down the +z axis from the enemy end:
 *
 *      ┌──────────────┐ ╷gap╷ ┌──────────────┐    enemy spawn sits behind the gap
 *      └──────────────┘ └───┘ └──────────────┘    and can only come out through it
 *                 ┌──────────────┐
 *                 └──────────────┘                the centre block
 *        ┌────┐                        ┌────┐
 *        └────┘                        └────┘     left block          right block
 *              ▲                   ×    ×
 *              │ the held lane
 *              ●  the shooter
 *
 * There are exactly two ways from the gap to the shooter. Left, down the lane he is
 * holding, past cover that looks inviting and is not — those are the `deathTraps`.
 * Right, the long way round the far side of the centre block, out of his line the
 * whole distance — the `safeGround`. Right is further. That is the point: a squad
 * that picks it is paying distance to avoid fire, which is the entire behaviour
 * under test, and one that picks left is dying to a corner it could see was hot.
 *
 * Geometry only. The scenario that drives it lives in main.js.
 */

/** Where the shooter stands, and the point he holds his sights on. */
export const LANE_TEST = {
  post: { x: -9, z: 13 },
  aim: { x: -9, z: -7.5 },
  enemySpawn: [
    { x: -1.6, y: 0, z: -12.6 },
    { x: -3.0, y: 0, z: -12.0 },
    { x: -0.2, y: 0, z: -12.0 },
    { x: -1.6, y: 0, z: -10.8 },
    { x: -3.0, y: 0, z: -10.4 },
  ],
  /** Cover on the lane side: reachable, tempting, and in the beaten zone. */
  deathTraps: [
    { x: -7.4, z: -5.5 },
    { x: -12.7, z: -1.5 },
    { x: -15.5, z: 3.6 },
  ],
  /** Cover on the far side: further from the shooter, and out of his lane. */
  safeGround: [
    { x: 8.9, z: -3.2 },
    { x: 14.2, z: 0.9 },
    { x: 15.6, z: 7.7 },
  ],
  /** How near one of those a fighter counts as "at" it. */
  markRadius: 3.5,
  /**
   * Where the watching camera sits. Straight over the pit and tilted a little, so
   * routes read as routes — the whole question is which way round they go, and that
   * is invisible from inside the fight.
   */
  camera: { x: -2, z: 6, height: 40, lookZ: -1 },
};

const WALL_H = 3.2;
const BLOCK_H = 2.4;

/**
 * The boxes. Returned rather than added, so a caller can build colliders for a
 * headless score and skip the meshes entirely.
 */
export function laneTestBoxes() {
  return [
    // Back wall across the pit, with the spawn gap left open in the middle.
    { cx: -12.5, cz: -8.5, w: 17, h: WALL_H, d: 0.9 },
    { cx: 11.5, cz: -8.5, w: 19, h: WALL_H, d: 0.9 },
    // The alcove the enemy spawns in: two sides, open toward the pit.
    { cx: -4.2, cz: -11.5, w: 0.9, h: WALL_H, d: 7 },
    { cx: 1.0, cz: -11.5, w: 0.9, h: WALL_H, d: 7 },
    // The centre block. Its left end is the corner the lane runs past.
    { cx: -0.6, cz: -2.5, w: 15.2, h: BLOCK_H, d: 3.9 },
    // Cover either side, one set in the lane and one set well out of it.
    { cx: -14.2, cz: 2.4, w: 5.8, h: BLOCK_H, d: 4.9 },
    { cx: 12.4, cz: 5.3, w: 4.7, h: BLOCK_H, d: 7.2 },
  ];
}

export function laneTestColliders() {
  return laneTestBoxes().map(b => new Collider(b.cx, 0, b.cz, b.w, b.h, b.d, 0));
}

/**
 * Build the visible map, so the scenario can be watched as well as scored.
 *
 * Returns a disposer that removes everything it added — the test map is a guest in
 * the real arena's scene, not a replacement for it.
 */
export function buildLaneTestMeshes(scene) {
  const material = new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.85, metalness: 0.05 });
  const added = [];

  // Its own floor. The caller hides the real pit's geometry while this runs, because
  // a map you can see and a map that stops bullets have to be the same map — leaving
  // the arena drawn over a test that no longer uses its colliders is how you end up
  // reasoning about walls that are not there.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 32),
    new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  floor.receiveShadow = true;
  scene.add(floor);
  added.push(floor);

  for (const b of laneTestBoxes()) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), material);
    mesh.position.set(b.cx, b.h / 2, b.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    added.push(mesh);
  }
  return () => {
    for (const mesh of added) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      if (mesh !== floor) continue;
      mesh.material.dispose();
    }
    material.dispose();
  };
}

/**
 * Draw the answer key: the spots being scored, and the lane being held.
 *
 * Watching a squad path around an invisible threat tells you very little. Red discs
 * are the tempting cover inside the beaten zone, green the long way round, and the
 * red strip is the lane itself — so what the numbers are counting is on screen.
 */
export function buildLaneTestMarkers(scene) {
  const added = [];
  const disc = (spot, colour) => {
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(LANE_TEST.markRadius, 24),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(spot.x, 0.03, spot.z);
    scene.add(mesh);
    added.push(mesh);
  };
  for (const spot of LANE_TEST.deathTraps) disc(spot, 0xd12b3a);
  for (const spot of LANE_TEST.safeGround) disc(spot, 0x2fbf4f);

  const dx = LANE_TEST.aim.x - LANE_TEST.post.x;
  const dz = LANE_TEST.aim.z - LANE_TEST.post.z;
  const length = Math.hypot(dx, dz);
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(2, length + 6),
    new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, opacity: 0.16, depthWrite: false }),
  );
  lane.rotation.x = -Math.PI / 2;
  lane.rotation.z = -Math.atan2(dx, dz);
  lane.position.set(
    LANE_TEST.post.x + dx / 2 - (dx / length) * 3,
    0.02,
    LANE_TEST.post.z + dz / 2 - (dz / length) * 3,
  );
  scene.add(lane);
  added.push(lane);

  return () => {
    for (const mesh of added) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  };
}

/** Which of the marked spots a fighter is standing at, if any. */
export function spotAt(pos, spots, radius = LANE_TEST.markRadius) {
  for (const spot of spots) {
    if (Math.hypot(pos.x - spot.x, pos.z - spot.z) <= radius) return spot;
  }
  return null;
}
