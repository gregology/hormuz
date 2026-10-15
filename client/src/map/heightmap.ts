/**
 * Terrain elevation queries with bilinear interpolation.
 *
 * The heightmap is a regular grid generated from real ETOPO elevation data
 * (see shared/scripts/generate_heightmap.py). All queries use bilinear
 * interpolation for smooth results between grid cells.
 */

import {
	HEIGHTMAP_CELL_SIZE,
	HEIGHTMAP_DATA,
	HEIGHTMAP_HEIGHT,
	HEIGHTMAP_WIDTH,
} from "./heightmap-data";

// ---------------------------------------------------------------------------
// Elevation query
// ---------------------------------------------------------------------------

/** Raw elevation at the nearest heightmap cell (no interpolation). */
export function getRawElevation(x: number, y: number): number {
	const col = Math.max(
		0,
		Math.min(Math.round(x / HEIGHTMAP_CELL_SIZE - 0.5), HEIGHTMAP_WIDTH - 1),
	);
	const row = Math.max(
		0,
		Math.min(Math.round(y / HEIGHTMAP_CELL_SIZE - 0.5), HEIGHTMAP_HEIGHT - 1),
	);
	return HEIGHTMAP_DATA[row * HEIGHTMAP_WIDTH + col];
}

/** Get interpolated terrain elevation at a world position (game units). */
export function getElevation(x: number, y: number): number {
	const gx = x / HEIGHTMAP_CELL_SIZE - 0.5;
	const gy = y / HEIGHTMAP_CELL_SIZE - 0.5;
	const ix = Math.floor(gx);
	const iy = Math.floor(gy);
	const fx = gx - ix;
	const fy = gy - iy;

	const v00 = sample(ix, iy);
	const v10 = sample(ix + 1, iy);
	const v01 = sample(ix, iy + 1);
	const v11 = sample(ix + 1, iy + 1);

	return (
		v00 * (1 - fx) * (1 - fy) +
		v10 * fx * (1 - fy) +
		v01 * (1 - fx) * fy +
		v11 * fx * fy
	);
}

// ---------------------------------------------------------------------------
// Gradient / slope queries
// ---------------------------------------------------------------------------

/** Terrain gradient (dz/dx, dz/dy) at a world position. */
export function getTerrainGradient(
	x: number,
	y: number,
): { dx: number; dy: number } {
	const h = HEIGHTMAP_CELL_SIZE;
	const ex = getElevation(x + h, y);
	const wx = getElevation(x - h, y);
	const ny = getElevation(x, y - h);
	const sy = getElevation(x, y + h);
	return {
		dx: (ex - wx) / (2 * h),
		dy: (sy - ny) / (2 * h),
	};
}

/** Slope along a given heading direction (positive = uphill). */
export function getSlopeAlongHeading(
	x: number,
	y: number,
	heading: number,
): number {
	const grad = getTerrainGradient(x, y);
	return grad.dx * Math.cos(heading) + grad.dy * Math.sin(heading);
}

// ---------------------------------------------------------------------------
// Grid metadata re-exports
// ---------------------------------------------------------------------------

export {
	HEIGHTMAP_WIDTH,
	HEIGHTMAP_HEIGHT,
	HEIGHTMAP_CELL_SIZE,
} from "./heightmap-data";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sample(col: number, row: number): number {
	const c = Math.max(0, Math.min(col, HEIGHTMAP_WIDTH - 1));
	const r = Math.max(0, Math.min(row, HEIGHTMAP_HEIGHT - 1));
	return HEIGHTMAP_DATA[r * HEIGHTMAP_WIDTH + c];
}
