/**
 * Shared types for the Three.js visual effects system.
 */

import type * as THREE from "three";

export interface ThreeEffect {
	/** False once the effect has finished and should be removed. */
	alive: boolean;

	/** The root Three.js object to add to the scene. */
	readonly root: THREE.Object3D;

	/**
	 * Advance the effect by dt seconds.
	 * Zoom is needed to convert screen-pixel sizes to world units.
	 */
	update(dt: number, zoom: number): void;

	/** Dispose all GPU resources owned by this effect. */
	dispose(): void;
}
