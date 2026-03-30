/**
 * Shared types for the visual effects system.
 */

import type { Graphics } from "pixi.js";
import type { Camera } from "../render/camera";

export interface Effect {
	/** False once the effect has finished and should be removed. */
	alive: boolean;

	/** Advance the effect by dt seconds. */
	update(dt: number): void;

	/** Draw the effect onto the shared Graphics object. */
	draw(g: Graphics, cam: Camera): void;
}
