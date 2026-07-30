import * as THREE from 'three';

const AERIAL_FOV = 64;
const CAMERA_WORLD_Y = 24;
const CAMERA_OFFSET_X = 6;
const CAMERA_OFFSET_Z = 8;
const LOOK_HEIGHT = 0.8;
const FOLLOW_DEAD_ZONE = 4.5;

export class SpectatorCamera {
  constructor(camera) {
    this.camera = camera;
    this.target = null;
    this.anchor = new THREE.Vector2();
    this.focus = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
  }

  reset() {
    this.target = null;
  }

  follow(target, dt) {
    const switched = target !== this.target;
    this.target = target;

    if (switched) {
      this.anchor.set(target.pos.x, target.pos.z);
    } else {
      const dx = target.pos.x - this.anchor.x;
      const dz = target.pos.z - this.anchor.y;
      const distance = Math.hypot(dx, dz);
      // The target can move freely inside a wide broadcast frame. The camera
      // only pans once they leave it, so animation/nav jitter never reaches the shot.
      if (distance > FOLLOW_DEAD_ZONE) {
        const overflow = distance - FOLLOW_DEAD_ZONE;
        this.anchor.x += (dx / distance) * overflow;
        this.anchor.y += (dz / distance) * overflow;
      }
    }

    this.focus.set(this.anchor.x, LOOK_HEIGHT, this.anchor.y);
    this.desiredPosition.set(
      this.anchor.x + CAMERA_OFFSET_X,
      CAMERA_WORLD_Y,
      this.anchor.y + CAMERA_OFFSET_Z,
    );

    if (switched) {
      this.camera.position.copy(this.desiredPosition);
    } else {
      this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-dt * 2.5));
      // Never allow another system's low camera transform to leak into a
      // spectator frame, even during a transition.
      this.camera.position.y = CAMERA_WORLD_Y;
    }

    if (this.camera.fov !== AERIAL_FOV) {
      this.camera.fov = AERIAL_FOV;
      this.camera.updateProjectionMatrix?.();
    }
    this.camera.lookAt(this.focus);
  }
}
