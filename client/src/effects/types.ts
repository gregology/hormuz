/**
 * Shared types for the Three.js visual effects system.
 */

import type * as THREE from "three";
import type { ParticleBatch } from "../render/particles";

/** Particle batches shared by all effects (one draw call each). */
export interface EffectParticles {
	/** White water: wake churn, bubbles, splashes. */
	spray: ParticleBatch;
	/** Smoke and dust. */
	smoke: ParticleBatch;
	/** Emissive sparks, embers and flames (additive, blooms). */
	glow: ParticleBatch;
}

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

	/** Add this frame's particles to the shared batches. */
	drawParticles?(particles: EffectParticles, zoom: number): void;

	/** Dispose all GPU resources owned by this effect. */
	dispose(): void;
}

/** Wind drift for smoke: the shamal blows from the north-west (world units/s). */
export const WIND = { x: 4, z: 4 } as const;
