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

// Pre-computed hillshade for the entire grid (computed once at load time)
let hillshadeCache: Float32Array | null = null;

// ---------------------------------------------------------------------------
// Elevation query
// ---------------------------------------------------------------------------

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
// Hillshade (pre-computed)
// ---------------------------------------------------------------------------

// NW light direction at ~35° altitude (light from upper-left in isometric view)
// In world space: X = east, Y = south. NW = (-X, -Y).
const LIGHT_DX = -0.5773; // -1/√3
const LIGHT_DY = -0.5773; // -1/√3
const LIGHT_DZ = 0.5773; //  1/√3

// Dot product of the light with a flat surface normal (0, 0, 1)
const FLAT_SHADE = LIGHT_DZ; // ≈ 0.577

/**
 * Get the pre-computed hillshade value for a grid cell.
 * Returns the raw light dot product: 0 = full shadow, FLAT_SHADE ≈ 0.577 = flat,
 * up to ~1.0 = fully lit slope. Returns -1 for ocean cells.
 */
export function getHillshade(col: number, row: number): number {
	if (!hillshadeCache) {
		hillshadeCache = computeHillshade();
	}
	if (col < 0 || col >= HEIGHTMAP_WIDTH || row < 0 || row >= HEIGHTMAP_HEIGHT)
		return -1;
	return hillshadeCache[row * HEIGHTMAP_WIDTH + col];
}

/** Flat ground baseline — used by the renderer to center shading. */
export const HILLSHADE_FLAT = FLAT_SHADE;

function computeHillshade(): Float32Array {
	const shade = new Float32Array(HEIGHTMAP_WIDTH * HEIGHTMAP_HEIGHT);
	// Exaggerate gradients to make hills more visible at our coarse grid
	const GRADIENT_SCALE = 3.0;

	for (let row = 0; row < HEIGHTMAP_HEIGHT; row++) {
		for (let col = 0; col < HEIGHTMAP_WIDTH; col++) {
			const idx = row * HEIGHTMAP_WIDTH + col;
			const elev = HEIGHTMAP_DATA[idx];
			if (elev === 0) {
				shade[idx] = -1; // ocean marker
				continue;
			}

			// Finite differences for surface gradient
			const left = sample(col - 1, row);
			const right = sample(col + 1, row);
			const up = sample(col, row - 1);
			const down = sample(col, row + 1);

			const dzdx =
				((right - left) / (2 * HEIGHTMAP_CELL_SIZE)) * GRADIENT_SCALE;
			const dzdy = ((down - up) / (2 * HEIGHTMAP_CELL_SIZE)) * GRADIENT_SCALE;

			// Surface normal: (-dzdx, -dzdy, 1) normalized
			const mag = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
			const nx = -dzdx / mag;
			const ny = -dzdy / mag;
			const nz = 1 / mag;

			// Dot product with light direction — raw value, not remapped
			const dot = nx * LIGHT_DX + ny * LIGHT_DY + nz * LIGHT_DZ;
			shade[idx] = Math.max(0, Math.min(1, dot));
		}
	}

	return shade;
}

// ---------------------------------------------------------------------------
// Hillshade texture (RGBA pixel data for GPU rendering)
// ---------------------------------------------------------------------------

/**
 * Generate RGBA pixel data for a hillshade texture.
 * The GPU's bilinear filtering produces smooth shading.
 * Shadows are black with alpha, highlights are white with alpha,
 * flat/ocean areas are fully transparent.
 */
export function createHillshadePixels(): {
	data: Uint8Array;
	width: number;
	height: number;
} {
	// Ensure hillshade is computed
	if (!hillshadeCache) {
		hillshadeCache = computeHillshade();
	}

	const w = HEIGHTMAP_WIDTH;
	const h = HEIGHTMAP_HEIGHT;
	const pixels = new Uint8Array(w * h * 4);
	const DEAD_ZONE = 0.03;

	for (let row = 0; row < h; row++) {
		for (let col = 0; col < w; col++) {
			const shade = hillshadeCache[row * w + col];
			const idx = (row * w + col) * 4;

			if (shade < 0) {
				// Ocean — fully transparent
				pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
			} else if (shade < FLAT_SHADE - DEAD_ZONE) {
				// Shadow
				const intensity = (FLAT_SHADE - shade) / FLAT_SHADE;
				pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = 0;
				pixels[idx + 3] = Math.round(intensity * 115);
			} else if (shade > FLAT_SHADE + DEAD_ZONE) {
				// Highlight
				const intensity = (shade - FLAT_SHADE) / (1 - FLAT_SHADE);
				pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = 255;
				pixels[idx + 3] = Math.round(intensity * 77);
			} else {
				// Flat — transparent
				pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
			}
		}
	}

	return { data: pixels, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Heightmap texture (for GPU shader consumption)
// ---------------------------------------------------------------------------

/**
 * Create RGBA pixel data encoding elevation in RG channels (16-bit).
 * R = low byte, G = high byte. Bilinear interpolation of both channels
 * independently produces correct linear interpolation of elevation values.
 */
export function createHeightmapPixels(): {
	data: Uint8Array;
	width: number;
	height: number;
} {
	const w = HEIGHTMAP_WIDTH;
	const h = HEIGHTMAP_HEIGHT;
	const pixels = new Uint8Array(w * h * 4);

	for (let i = 0; i < w * h; i++) {
		const v = HEIGHTMAP_DATA[i];
		pixels[i * 4] = v & 0xff;
		pixels[i * 4 + 1] = (v >> 8) & 0xff;
		pixels[i * 4 + 2] = 0;
		pixels[i * 4 + 3] = 255;
	}

	return { data: pixels, width: w, height: h };
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
