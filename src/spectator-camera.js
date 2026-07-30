import * as THREE from 'three';

const AERIAL_FOV = 60;
const AERIAL_HEIGHT = 14;
const AERIAL_OFFSET_X = 6;
const AERIAL_OFFSET_Z = 7;
const ENGAGEMENT_RANGE = 20;
const TARGET_WEIGHT = 0.72;

function nearestOpponent(target, combatants) {
  let nearest = null;
  let nearestDistance = ENGAGEMENT_RANGE * ENGAGEMENT_RANGE;
  for (const combatant of combatants) {
    if (!combatant?.alive || combatant.team === target.team) continue;
    const distance = target.pos.distanceToSquared(combatant.pos);
    if (distance < nearestDistance) {
      nearest = combatant;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export class SpectatorCamera {
  constructor(camera) {
    this.camera = camera;
    this.target = null;
    this.focus = new THREE.Vector3();
    this.desiredFocus = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
  }

  reset() {
    this.target = null;
  }

  follow(target, dt, combatants = []) {
    const switched = target !== this.target;
    this.target = target;

    const opponent = nearestOpponent(target, combatants);
    this.desiredFocus.copy(target.pos);
    if (opponent) {
      this.desiredFocus.multiplyScalar(TARGET_WEIGHT)
        .addScaledVector(opponent.pos, 1 - TARGET_WEIGHT);
    }
    this.desiredFocus.y = Math.max(
      target.pos.y,
      opponent?.pos.y ?? target.pos.y
    ) + 0.8;

    const engagementDistance = opponent ? target.pos.distanceTo(opponent.pos) : 0;
    const extraHeight = Math.min(4, engagementDistance * 0.18);
    this.desiredPosition.set(
      this.desiredFocus.x + AERIAL_OFFSET_X,
      this.desiredFocus.y + AERIAL_HEIGHT + extraHeight,
      this.desiredFocus.z + AERIAL_OFFSET_Z,
    );

    if (switched) {
      this.focus.copy(this.desiredFocus);
      this.camera.position.copy(this.desiredPosition);
    } else {
      this.focus.lerp(this.desiredFocus, 1 - Math.exp(-dt * 5));
      this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-dt * 4));
    }

    if (this.camera.fov !== AERIAL_FOV) {
      this.camera.fov = AERIAL_FOV;
      this.camera.updateProjectionMatrix?.();
    }
    this.camera.lookAt(this.focus);
  }
}
