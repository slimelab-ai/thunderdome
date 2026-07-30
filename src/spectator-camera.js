import * as THREE from 'three';
import { wallHit } from './combat.js';

const SPECTATOR_FOV = 70;
const CAMERA_HEIGHT = 4.4;
const CAMERA_DISTANCE = 6.2;
const CAMERA_SIDE = 1.7;
const TARGET_LOOK_HEIGHT = 1.15;
const ACTION_LOOK_AHEAD = 0.22;

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
  constructor(camera, colliders = []) {
    this.camera = camera;
    this.colliders = colliders;
    this.target = null;
    this.smoothedTarget = new THREE.Vector3();
    this.smoothedOpponent = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, 1);
    this.focus = new THREE.Vector3();
    this.desiredFocus = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.ray = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.side = 1;
  }

  reset() {
    this.target = null;
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
    this.desiredPosition.copy(this.smoothedTarget)
      .addScaledVector(this.heading, -CAMERA_DISTANCE)
      .addScaledVector(this.right, CAMERA_SIDE * this.side);
    this.desiredPosition.y = this.smoothedTarget.y + CAMERA_HEIGHT;

    // If the preferred broadcast angle sits behind solid cover, lift and tighten
    // the shot instead of placing the camera inside the obstacle.
    this.ray.copy(this.desiredPosition).sub(this.focus);
    const desiredDistance = this.ray.length();
    this.ray.normalize();
    const obstruction = wallHit(this.colliders, this.focus, this.ray, desiredDistance);
    if (obstruction.dist < desiredDistance - 0.3) {
      this.desiredPosition.copy(this.smoothedTarget)
        .addScaledVector(this.heading, -3.2)
        .addScaledVector(this.right, 1.1 * this.side);
      this.desiredPosition.y = this.smoothedTarget.y + 5;
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
