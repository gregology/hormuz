/**
 * Perspective follow camera for the third- and first-person views, with
 * mouse/touch look-around (shared by the game client and the playground).
 *
 * Third person orbits the vehicle. By default the orbit is free: the view
 * direction is a world-space yaw, so the keyboard can turn the ship
 * without swinging the camera, and the mouse decides where to look. With
 * `followHeading` the orbit is instead relative to the vehicle's heading
 * (a classic chase cam). First person always looks relative to the
 * heading, like turning your head on the bridge.
 *
 * Angles use the game's heading convention: 0 = east, +π/2 = south.
 * Pitch is how far the view tilts down: in third person it lifts the
 * camera above the vehicle; in first person it lowers the gaze.
 */

import type * as THREE from "three";

export type ChaseMode = "third-person" | "first-person";

export interface ChaseTarget {
	x: number;
	/** Game Y (south) — Three.js Z. */
	y: number;
	heading: number;
	/** Height of the vehicle's base above sea level (terrain or flight altitude). */
	baseHeight: number;
	size: number;
}

export interface ChaseSettings {
	/** Third-person orbit radius, in vehicle lengths. */
	distance: number;
	/** Third-person default elevation of the camera above the vehicle (radians). */
	pitch: number;
	/** First-person eye height and forward offset, in vehicle lengths. */
	eyeHeight: number;
	eyeForward: number;
	/** Position follow rate (1/s); higher is snappier. */
	smoothing: number;
	/** Look sensitivity, radians per pixel of mouse movement. */
	sensitivity: number;
	/** Third person: orbit turns with the vehicle instead of staying put in the world. */
	followHeading: boolean;
}

export const DEFAULT_CHASE_SETTINGS: ChaseSettings = {
	distance: 3,
	pitch: Math.atan2(1.5, 3),
	eyeHeight: 0.5,
	eyeForward: 0.3,
	smoothing: 8,
	sensitivity: 0.0035,
	followHeading: false,
};

/** Third person: from just above the horizon to almost straight down. */
const THIRD_PERSON_PITCH: [number, number] = [-0.05, 1.4];
/** First person: look up a little, down a lot. */
const FIRST_PERSON_PITCH: [number, number] = [-0.6, 1.2];
const FIRST_PERSON_DEFAULT_PITCH = 0.08;
const ZOOM_RANGE: [number, number] = [0.3, 5];
/** Where the third-person camera aims, above the vehicle's base (vehicle lengths). */
const AIM_HEIGHT = 0.2;

export interface CameraPose {
	position: [number, number, number];
	lookAt: [number, number, number];
}

export class ChaseCamera {
	/** Third person (free): world yaw of the view. Otherwise: offset from the heading. */
	yaw = 0;
	pitch: number;
	/** Multiplier on the orbit distance (scroll wheel). */
	zoom = 1;

	constructor(
		readonly settings: ChaseSettings = { ...DEFAULT_CHASE_SETTINGS },
	) {
		this.pitch = settings.pitch;
	}

	/** Look straight ahead along the vehicle's heading. */
	reset(mode: ChaseMode, heading: number): void {
		const free = mode === "third-person" && !this.settings.followHeading;
		this.yaw = free ? heading : 0;
		this.pitch =
			mode === "third-person"
				? this.settings.pitch
				: FIRST_PERSON_DEFAULT_PITCH;
	}

	/** Turn the view by a mouse/touch movement in screen pixels. */
	look(mode: ChaseMode, dxPixels: number, dyPixels: number): void {
		this.yaw = wrapAngle(this.yaw + dxPixels * this.settings.sensitivity);
		const [min, max] =
			mode === "third-person" ? THIRD_PERSON_PITCH : FIRST_PERSON_PITCH;
		this.pitch = clamp(
			this.pitch + dyPixels * this.settings.sensitivity,
			min,
			max,
		);
	}

	/** Scroll to move the third-person camera in (negative delta) or out. */
	zoomBy(wheelDeltaY: number): void {
		this.zoom = clamp(this.zoom * 1.1 ** Math.sign(wheelDeltaY), ...ZOOM_RANGE);
	}

	/** Where the camera should be for this target. */
	pose(mode: ChaseMode, target: ChaseTarget): CameraPose {
		const { size } = target;
		if (mode === "third-person") {
			const yaw = this.settings.followHeading
				? target.heading + this.yaw
				: this.yaw;
			const radius = size * this.settings.distance * this.zoom;
			const aimY = target.baseHeight + size * AIM_HEIGHT;
			const horizontal = radius * Math.cos(this.pitch);
			return {
				position: [
					target.x - Math.cos(yaw) * horizontal,
					aimY + radius * Math.sin(this.pitch),
					target.y - Math.sin(yaw) * horizontal,
				],
				lookAt: [target.x, aimY, target.y],
			};
		}

		const forward = size * this.settings.eyeForward;
		const eyeY = target.baseHeight + size * this.settings.eyeHeight;
		const eyeX = target.x + Math.cos(target.heading) * forward;
		const eyeZ = target.y + Math.sin(target.heading) * forward;
		const yaw = target.heading + this.yaw;
		const reach = size * 2;
		return {
			position: [eyeX, eyeY, eyeZ],
			lookAt: [
				eyeX + Math.cos(yaw) * Math.cos(this.pitch) * reach,
				eyeY - Math.sin(this.pitch) * reach,
				eyeZ + Math.sin(yaw) * Math.cos(this.pitch) * reach,
			],
		};
	}

	/**
	 * Move a Three.js camera towards the pose. `snap` jumps straight there
	 * (e.g. on switching modes); otherwise the position eases in, which
	 * smooths the orbit while the view direction stays responsive.
	 */
	apply(
		camera: THREE.PerspectiveCamera,
		mode: ChaseMode,
		target: ChaseTarget,
		dt: number,
		snap: boolean,
	): void {
		const { position, lookAt } = this.pose(mode, target);
		if (snap || mode === "first-person") {
			camera.position.set(...position);
		} else {
			const t = 1 - Math.exp(-this.settings.smoothing * dt);
			camera.position.x += (position[0] - camera.position.x) * t;
			camera.position.y += (position[1] - camera.position.y) * t;
			camera.position.z += (position[2] - camera.position.z) * t;
		}
		camera.lookAt(...lookAt);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function wrapAngle(angle: number): number {
	return Math.atan2(Math.sin(angle), Math.cos(angle));
}
