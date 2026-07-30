import * as THREE from 'three';
import { wallHit } from './combat.js';

const FOLLOW_DISTANCE = 5.8;
const FOLLOW_HEIGHT = 3.2;
const SHOULDER_OFFSET = 1.15;
const WALL_PADDING = 0.38;

export class SpectatorCamera {
  constructor(camera, colliders) {
    this.camera = camera;
    this.colliders = colliders;
    this.target = null;
    this.shoulder = 1;
    this.heading = new THREE.Vector3(0, 0, 1);
    this.look = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.desired = new THREE.Vector3();
    this.safe = new THREE.Vector3();
    this.ray = new THREE.Vector3();
    this.side = new THREE.Vector3();
  }

  reset() {
    this.target = null;
  }

  _safeCameraPosition(target, heading, shoulder) {
    this.focus.set(target.pos.x, target.pos.y + 1.35, target.pos.z);
    this.side.set(heading.z, 0, -heading.x).multiplyScalar(shoulder * SHOULDER_OFFSET);
    this.desired.copy(this.focus)
      .addScaledVector(heading, -FOLLOW_DISTANCE)
      .add(this.side);
    this.desired.y += FOLLOW_HEIGHT;

    this.ray.copy(this.desired).sub(this.focus);
    const distance = this.ray.length();
    this.ray.normalize();
    const hit = wallHit(this.colliders, this.focus, this.ray, distance);
    const clearance = Math.max(0.5, Math.min(distance, hit.dist - WALL_PADDING));
    this.safe.copy(this.focus).addScaledVector(this.ray, clearance);
    return { position: this.safe, clearance };
  }

  follow(target, dt) {
    const switched = target !== this.target;
    const targetHeading = this.ray.set(Math.sin(target.yaw), 0, Math.cos(target.yaw));
    if (switched) {
      this.target = target;
      this.heading.copy(targetHeading);
      this.shoulder = ((target.navSeed || 0) & 1) ? -1 : 1;
    } else {
      this.heading.lerp(targetHeading, 1 - Math.exp(-dt * 2.2)).normalize();
    }

    let pose = this._safeCameraPosition(target, this.heading, this.shoulder);
    if (pose.clearance < 2.25) {
      const opposite = this._safeCameraPosition(target, this.heading, -this.shoulder);
      if (opposite.clearance > pose.clearance + 0.75) {
        this.shoulder *= -1;
        pose = opposite;
      } else {
        pose = this._safeCameraPosition(target, this.heading, this.shoulder);
      }
    }

    if (switched) {
      this.camera.position.copy(pose.position);
      this.look.copy(this.focus).addScaledVector(this.heading, 1.4);
    } else {
      this.camera.position.lerp(pose.position, 1 - Math.exp(-dt * 4.2));
      this.desired.copy(this.focus).addScaledVector(this.heading, 1.4);
      this.look.lerp(this.desired, 1 - Math.exp(-dt * 6));
    }
    this.camera.lookAt(this.look);
  }
}
