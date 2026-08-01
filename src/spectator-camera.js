import * as THREE from 'three';
import { wallHit } from './combat.js';

const SPECTATOR_FOV = 70;
const CAMERA_HEIGHT = 4.4;
const CAMERA_DISTANCE = 6.2;
const CAMERA_SIDE = 1.7;
const TARGET_LOOK_HEIGHT = 1.15;
const ACTION_LOOK_AHEAD = 0.22;
const CAMERA_PROBE_HEIGHT = 1.1;
const CAMERA_WALL_MARGIN = 0.55;
const CAMERA_BOUNDARY_MARGIN = 0.35;
const ORBIT_ANGLES = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI];

function nearestOpponent(target, combatants) {
  let nearest = null;
  let bestDistance = Infinity;
  for (const combatant of combatants) {
    if (!combatant?.alive || combatant.team === target.team) continue;
    const distance = target.pos.distanceToSquared(combatant.pos);
    if (distance < bestDistance) {
      nearest = combatant;
      bestDistance = distance;
    }
  }
  return nearest;
}

export class SpectatorCamera {
  constructor(camera, world = [], bounds = null) {
    this.camera = camera;
    // Either the arena/world (which routes camera probes through the real geometry,
    // same as shots) or a bare collider array, which is what the tests hand it.
    this.colliders = world;
    this.bounds = bounds;
    this.target = null;
    this.smoothedTarget = new THREE.Vector3();
    this.smoothedOpponent = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, 1);
    this.focus = new THREE.Vector3();
    this.desiredFocus = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.ray = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.baseOffset = new THREE.Vector3();
    this.candidateOffset = new THREE.Vector3();
    this.candidatePosition = new THREE.Vector3();
    this.probeOrigin = new THREE.Vector3();
    this.bestPosition = new THREE.Vector3();
    this.orbitAngle = 0;
    this.side = 1;
  }

  reset() {
    this.target = null;
    this.orbitAngle = 0;
  }

  follow(target, dt, combatants = []) {
    const firstFrame = this.target === null;
    const switched = !firstFrame && target !== this.target;
    this.target = target;
    const opponent = nearestOpponent(target, combatants);

    if (firstFrame || switched) {
      this.smoothedTarget.copy(target.pos);
      this.smoothedOpponent.copy(opponent?.pos || target.pos);
      this.side = ((target.navSeed || 0) & 1) ? -1 : 1;
      this.orbitAngle = 0;
    } else {
      this.smoothedTarget.lerp(target.pos, 1 - Math.exp(-dt * 3.2));
      this.smoothedOpponent.lerp(opponent?.pos || target.pos, 1 - Math.exp(-dt * 2));
    }

    const desiredHeading = this.ray.copy(this.smoothedOpponent).sub(this.smoothedTarget);
    desiredHeading.y = 0;
    if (desiredHeading.lengthSq() < 0.01) {
      desiredHeading.set(Math.sin(target.yaw || 0), 0, Math.cos(target.yaw || 0));
    } else {
      desiredHeading.normalize();
    }
    if (firstFrame) this.heading.copy(desiredHeading);
    else this.heading.lerp(desiredHeading, 1 - Math.exp(-dt * 1.8)).normalize();

    const actionDistance = opponent
      ? Math.min(5, this.smoothedTarget.distanceTo(this.smoothedOpponent))
      : 0;
    this.desiredFocus.copy(this.smoothedTarget)
      .addScaledVector(this.heading, actionDistance * ACTION_LOOK_AHEAD);
    this.desiredFocus.y = this.smoothedTarget.y + TARGET_LOOK_HEIGHT;
    if (firstFrame || switched) this.focus.copy(this.desiredFocus);
    else this.focus.lerp(this.desiredFocus, 1 - Math.exp(-dt * 3.5));

    this.right.set(this.heading.z, 0, -this.heading.x);
    this.baseOffset.copy(this.heading).multiplyScalar(-CAMERA_DISTANCE)
      .addScaledVector(this.right, CAMERA_SIDE * this.side);
    this.probeOrigin.copy(this.smoothedTarget);
    this.probeOrigin.y += CAMERA_PROBE_HEIGHT;

    let bestScore = -Infinity;
    let bestAngle = 0;
    for (const angle of ORBIT_ANGLES) {
      const cos = Math.cos(angle), sin = Math.sin(angle);
      this.candidateOffset.set(
        this.baseOffset.x * cos + this.baseOffset.z * sin,
        0,
        -this.baseOffset.x * sin + this.baseOffset.z * cos,
      );
      const orbitDistance = this.candidateOffset.length();
      this.candidateOffset.normalize();

      // Probe horizontally at fighter height. Boundary walls still stop the
      // camera even though the final elevated shot could otherwise pass over them.
      const boundary = wallHit(
        this.colliders,
        this.probeOrigin,
        this.candidateOffset,
        orbitDistance,
      );
      const hitBoundary = boundary.dist < orbitDistance - 0.01;
      const safeOrbitDistance = hitBoundary
        ? Math.max(0.08, boundary.dist - CAMERA_WALL_MARGIN)
        : orbitDistance;
      this.candidatePosition.copy(this.smoothedTarget)
        .addScaledVector(this.candidateOffset, safeOrbitDistance);
      this.candidatePosition.y = this.smoothedTarget.y + CAMERA_HEIGHT;
      let clampedToArena = false;
      if (this.bounds) {
        const maxX = this.bounds.halfWidth - CAMERA_BOUNDARY_MARGIN;
        const maxZ = this.bounds.halfDepth - CAMERA_BOUNDARY_MARGIN;
        const safeX = Math.max(-maxX, Math.min(maxX, this.candidatePosition.x));
        const safeZ = Math.max(-maxZ, Math.min(maxZ, this.candidatePosition.z));
        clampedToArena = Math.abs(safeX - this.candidatePosition.x) > 0.01
          || Math.abs(safeZ - this.candidatePosition.z) > 0.01;
        this.candidatePosition.x = safeX;
        this.candidatePosition.z = safeZ;
      }

      // Also require a clear view back to the action. If cover clips the sightline,
      // stop on the arena side of it rather than jumping through the obstacle.
      this.ray.copy(this.candidatePosition).sub(this.focus);
      const shotDistance = this.ray.length();
      this.ray.normalize();
      const obstruction = wallHit(this.colliders, this.focus, this.ray, shotDistance);
      const hitCover = obstruction.dist < shotDistance - 0.01;
      const safeShotDistance = hitCover
        ? Math.max(0.08, obstruction.dist - CAMERA_WALL_MARGIN)
        : shotDistance;
      if (hitCover) {
        this.candidatePosition.copy(this.focus).addScaledVector(this.ray, safeShotDistance);
      }

      const currentAngleBonus = Math.abs(angle - this.orbitAngle) < 0.01 ? 0.35 : 0;
      const boundaryPenalty = clampedToArena ? 4 : 0;
      const score = safeShotDistance - Math.abs(angle) * 0.22 + currentAngleBonus - boundaryPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
        this.bestPosition.copy(this.candidatePosition);
      }
    }
    this.orbitAngle = bestAngle;
    this.desiredPosition.copy(this.bestPosition);
    if (Math.abs(bestAngle) > Math.PI * 0.75) {
      // In a true corner, the only long orbit can be directly between the fighter
      // and the fight. Use a compact overhead shot that still faces into the arena.
      this.desiredPosition.copy(this.smoothedTarget).addScaledVector(this.heading, 0.45);
      this.desiredPosition.y = this.smoothedTarget.y + 5;
      this.focus.copy(this.smoothedTarget).addScaledVector(this.heading, 2.2);
      this.focus.y = this.smoothedTarget.y + TARGET_LOOK_HEIGHT;
    }
    if (this.bounds) {
      const maxX = this.bounds.halfWidth - CAMERA_BOUNDARY_MARGIN;
      const maxZ = this.bounds.halfDepth - CAMERA_BOUNDARY_MARGIN;
      this.desiredPosition.x = Math.max(-maxX, Math.min(maxX, this.desiredPosition.x));
      this.desiredPosition.z = Math.max(-maxZ, Math.min(maxZ, this.desiredPosition.z));
    }

    if (firstFrame) {
      this.camera.position.copy(this.desiredPosition);
    } else {
      const moveRate = switched ? 6 : 2.6;
      this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-dt * moveRate));
    }

    if (this.camera.fov !== SPECTATOR_FOV) {
      this.camera.fov = SPECTATOR_FOV;
      this.camera.updateProjectionMatrix?.();
    }
    this.camera.lookAt(this.focus);
  }
}
