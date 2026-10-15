/**
 * Height of the rendered terrain surface — the displaced terrain mesh and
 * anything that sits on it (land vehicles) use this so they agree.
 *
 * It follows the gameplay heightmap, except that it eases down to just
 * above sea level within a short distance of the coast. That keeps the
 * rendered shoreline on the coastline polygons instead of floating a few
 * units up-screen as a cliff.
 */

import { getCoastField, sampleField } from "../map/coast-field";
import { getElevation } from "../map/heightmap";

/** Land sits this far above the sea surface so the two never z-fight. */
export const TERRAIN_BASE_HEIGHT = 0.6;

/** Inland distance (world units) over which coastal terrain rises to full height. */
export const COAST_RAMP_DISTANCE = 300;

export function terrainSurfaceHeight(x: number, y: number): number {
	const field = getCoastField();
	const inland = -sampleField(field.signedDistance, field.grid, x, y);
	return (
		Math.max(getElevation(x, y), 0) * smoothstep(inland) + TERRAIN_BASE_HEIGHT
	);
}

function smoothstep(inland: number): number {
	const t = Math.max(0, Math.min(1, inland / COAST_RAMP_DISTANCE));
	return t * t * (3 - 2 * t);
}
