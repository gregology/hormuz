/**
 * Coast field — signed distance to the coastline plus soft depth-zone
 * masks, sampled on a regular grid over the whole map.
 *
 * The coastline polygons stay the ground truth for land/water (see
 * terrain.ts). This field lets shaders ask "how far am I from the coast?"
 * per pixel: water colour by depth proxy, surf lines, beaches, and the
 * terrain mesh's land clip. Distances near the coast are exact
 * point-to-segment distances so the rendered shoreline tracks the
 * polygons; further out a Euclidean distance transform is plenty.
 */

import type { Polygon } from "../generated/map_data";
import {
	ARABIAN_COAST_POLYS,
	IRAN_COAST_POLYS,
	ISLAND_POLYGONS,
} from "./coastlines";
import {
	MAP,
	ROCKS,
	SHALLOW_WATERS,
	SHOALS,
	VERY_SHALLOW_WATERS,
} from "./data";

export interface Grid {
	readonly width: number;
	readonly height: number;
	readonly cellSize: number;
}

export interface CoastField {
	readonly grid: Grid;
	/** World units to the nearest coastline: positive over water, negative on land. */
	readonly signedDistance: Float32Array;
	/** 0..1 soft masks of the charted depth zones. */
	readonly shallow: Float32Array;
	readonly veryShallow: Float32Array;
	/** 0..1 soft mask of shoals and rocks (breaking water). */
	readonly shoal: Float32Array;
}

export const COAST_FIELD_CELL_SIZE = 100;

/** Cells within this many cells of the coast get exact distances. */
const EXACT_BAND_CELLS = 4;
const INFINITE = 1e20;

export const LAND_POLYGONS: readonly Polygon[] = [
	...IRAN_COAST_POLYS,
	...ARABIAN_COAST_POLYS,
	...ISLAND_POLYGONS.map((island) => island.polygon),
];

let cachedField: CoastField | null = null;

/** The coast field for the game map (computed once, ~100 ms). */
export function getCoastField(): CoastField {
	if (!cachedField) {
		const grid: Grid = {
			width: Math.ceil(MAP.width / COAST_FIELD_CELL_SIZE),
			height: Math.ceil(MAP.height / COAST_FIELD_CELL_SIZE),
			cellSize: COAST_FIELD_CELL_SIZE,
		};
		cachedField = {
			grid,
			signedDistance: signedDistanceField(LAND_POLYGONS, grid),
			shallow: softMask(SHALLOW_WATERS, grid, 4),
			veryShallow: softMask(VERY_SHALLOW_WATERS, grid, 3),
			shoal: softMask([...SHOALS, ...ROCKS.map(rockPolygon)], grid, 2),
		};
	}
	return cachedField;
}

/** Bilinearly interpolated sample of a grid-aligned field at a world position. */
export function sampleField(
	values: Float32Array,
	grid: Grid,
	x: number,
	y: number,
): number {
	const gx = Math.max(0, Math.min(x / grid.cellSize - 0.5, grid.width - 1));
	const gy = Math.max(0, Math.min(y / grid.cellSize - 0.5, grid.height - 1));
	const x0 = Math.floor(gx);
	const y0 = Math.floor(gy);
	const x1 = Math.min(x0 + 1, grid.width - 1);
	const y1 = Math.min(y0 + 1, grid.height - 1);
	const fx = gx - x0;
	const fy = gy - y0;
	const top =
		values[y0 * grid.width + x0] * (1 - fx) + values[y0 * grid.width + x1] * fx;
	const bottom =
		values[y1 * grid.width + x0] * (1 - fx) + values[y1 * grid.width + x1] * fx;
	return top * (1 - fy) + bottom * fy;
}

/**
 * 1 for every cell whose centre lies inside any polygon. Uses the same
 * even-odd crossing rule as terrain.ts so the two always agree.
 */
export function rasterizePolygons(
	polygons: readonly Polygon[],
	grid: Grid,
): Uint8Array {
	const { width, height, cellSize } = grid;
	const mask = new Uint8Array(width * height);
	const crossings: number[] = [];

	for (const poly of polygons) {
		if (poly.length < 3) continue;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const [, y] of poly) {
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
		const rowStart = Math.max(0, Math.floor(minY / cellSize - 0.5));
		const rowEnd = Math.min(height - 1, Math.ceil(maxY / cellSize - 0.5));

		for (let row = rowStart; row <= rowEnd; row++) {
			const py = (row + 0.5) * cellSize;
			crossings.length = 0;
			for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const [xi, yi] = poly[i];
				const [xj, yj] = poly[j];
				if (yi > py !== yj > py) {
					crossings.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
				}
			}
			crossings.sort((a, b) => a - b);
			for (let k = 0; k + 1 < crossings.length; k += 2) {
				const colStart = Math.max(0, Math.ceil(crossings[k] / cellSize - 0.5));
				const colEnd = Math.min(
					width - 1,
					Math.ceil(crossings[k + 1] / cellSize - 0.5) - 1,
				);
				mask.fill(1, row * width + colStart, row * width + colEnd + 1);
			}
		}
	}
	return mask;
}

/** Signed distance (world units) to the boundary of the union of `polygons`. */
export function signedDistanceField(
	polygons: readonly Polygon[],
	grid: Grid,
): Float32Array {
	const { width, height, cellSize } = grid;
	const inside = rasterizePolygons(polygons, grid);
	const toInside = squaredDistanceTransform(inside, 1, grid);
	const toOutside = squaredDistanceTransform(inside, 0, grid);

	const field = new Float32Array(width * height);
	for (let i = 0; i < field.length; i++) {
		field[i] = inside[i]
			? -(Math.sqrt(toOutside[i]) - 0.5) * cellSize
			: (Math.sqrt(toInside[i]) - 0.5) * cellSize;
	}

	refineNearBoundary(field, inside, polygons, grid);
	return field;
}

/** Box-blurred polygon mask, 0..1, for soft-edged depth zones. */
export function softMask(
	polygons: readonly Polygon[],
	grid: Grid,
	radiusCells: number,
): Float32Array {
	const mask = rasterizePolygons(polygons, grid);
	let values: Float32Array = Float32Array.from(mask);
	// Two box passes approximate a Gaussian.
	for (let pass = 0; pass < 2; pass++) {
		values = boxBlur(values, grid, radiusCells);
	}
	return values;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Rocks break the surface over a wider patch than their charted radius. */
function rockPolygon(rock: {
	position: readonly [number, number];
	radius: number;
}): Polygon {
	const [cx, cy] = rock.position;
	const radius = rock.radius * 2;
	return Array.from({ length: 16 }, (_, i) => {
		const angle = (i / 16) * Math.PI * 2;
		return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius] as [
			number,
			number,
		];
	});
}

/** Squared distance (in cells) from every cell to the nearest cell equal to `feature`. */
function squaredDistanceTransform(
	mask: Uint8Array,
	feature: number,
	grid: Grid,
): Float64Array {
	const { width, height } = grid;
	const result = new Float64Array(width * height);
	for (let i = 0; i < result.length; i++) {
		result[i] = mask[i] === feature ? 0 : INFINITE;
	}

	const longest = Math.max(width, height);
	const f = new Float64Array(longest);
	const d = new Float64Array(longest);
	const v = new Int32Array(longest);
	const z = new Float64Array(longest + 1);

	for (let col = 0; col < width; col++) {
		for (let row = 0; row < height; row++) f[row] = result[row * width + col];
		distanceTransform1d(f, height, d, v, z);
		for (let row = 0; row < height; row++) result[row * width + col] = d[row];
	}
	for (let row = 0; row < height; row++) {
		const offset = row * width;
		for (let col = 0; col < width; col++) f[col] = result[offset + col];
		distanceTransform1d(f, width, d, v, z);
		for (let col = 0; col < width; col++) result[offset + col] = d[col];
	}
	return result;
}

/** Felzenszwalb & Huttenlocher's lower-envelope-of-parabolas transform. */
function distanceTransform1d(
	f: Float64Array,
	n: number,
	d: Float64Array,
	v: Int32Array,
	z: Float64Array,
): void {
	let k = 0;
	v[0] = 0;
	z[0] = Number.NEGATIVE_INFINITY;
	z[1] = Number.POSITIVE_INFINITY;
	for (let q = 1; q < n; q++) {
		let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		while (s <= z[k]) {
			k--;
			s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		}
		k++;
		v[k] = q;
		z[k] = s;
		z[k + 1] = Number.POSITIVE_INFINITY;
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1] < q) k++;
		d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
	}
}

/**
 * Replace transform distances near the boundary with exact distances to
 * the polygon edges. Edges shared by two land polygons (land on both
 * sides) are skipped so they don't draw phantom shorelines inland.
 */
function refineNearBoundary(
	field: Float32Array,
	inside: Uint8Array,
	polygons: readonly Polygon[],
	grid: Grid,
): void {
	const { width, height, cellSize } = grid;
	const bucketCells = 8;
	const bucketSize = bucketCells * cellSize;
	const bucketCols = Math.ceil(width / bucketCells);
	const bucketRows = Math.ceil(height / bucketCells);
	const buckets: number[][] = Array.from(
		{ length: bucketCols * bucketRows },
		() => [],
	);
	const segments: number[] = [];

	const isInsideAt = (x: number, y: number): boolean => {
		const col = Math.floor(x / cellSize);
		const row = Math.floor(y / cellSize);
		if (col < 0 || row < 0 || col >= width || row >= height) return false;
		return inside[row * width + col] === 1;
	};

	for (const poly of polygons) {
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const [ax, ay] = poly[j];
			const [bx, by] = poly[i];
			const length = Math.hypot(bx - ax, by - ay);
			if (length === 0) continue;
			const midX = (ax + bx) / 2;
			const midY = (ay + by) / 2;
			const nx = ((by - ay) / length) * cellSize;
			const ny = (-(bx - ax) / length) * cellSize;
			if (isInsideAt(midX + nx, midY + ny) && isInsideAt(midX - nx, midY - ny))
				continue;

			const index = segments.length / 4;
			segments.push(ax, ay, bx, by);
			const c0 = clampInt(
				Math.floor(Math.min(ax, bx) / bucketSize),
				bucketCols,
			);
			const c1 = clampInt(
				Math.floor(Math.max(ax, bx) / bucketSize),
				bucketCols,
			);
			const r0 = clampInt(
				Math.floor(Math.min(ay, by) / bucketSize),
				bucketRows,
			);
			const r1 = clampInt(
				Math.floor(Math.max(ay, by) / bucketSize),
				bucketRows,
			);
			for (let r = r0; r <= r1; r++) {
				for (let c = c0; c <= c1; c++) buckets[r * bucketCols + c].push(index);
			}
		}
	}

	const band = EXACT_BAND_CELLS * cellSize;
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			const i = row * width + col;
			if (Math.abs(field[i]) > band) continue;
			const px = (col + 0.5) * cellSize;
			const py = (row + 0.5) * cellSize;
			const bc = Math.floor(px / bucketSize);
			const br = Math.floor(py / bucketSize);
			let best = Number.POSITIVE_INFINITY;
			for (let r = br - 1; r <= br + 1; r++) {
				if (r < 0 || r >= bucketRows) continue;
				for (let c = bc - 1; c <= bc + 1; c++) {
					if (c < 0 || c >= bucketCols) continue;
					for (const s of buckets[r * bucketCols + c]) {
						const dist = pointSegmentDistance(
							px,
							py,
							segments[s * 4],
							segments[s * 4 + 1],
							segments[s * 4 + 2],
							segments[s * 4 + 3],
						);
						if (dist < best) best = dist;
					}
				}
			}
			if (best < Number.POSITIVE_INFINITY) {
				field[i] = inside[i] ? -best : best;
			}
		}
	}
}

function pointSegmentDistance(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSq = dx * dx + dy * dy;
	const t = Math.max(
		0,
		Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq),
	);
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function boxBlur(
	values: Float32Array,
	grid: Grid,
	radius: number,
): Float32Array {
	const { width, height } = grid;
	const horizontal = new Float32Array(values.length);
	const out = new Float32Array(values.length);
	const span = 2 * radius + 1;
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				const c = Math.max(0, Math.min(width - 1, col + k));
				sum += values[row * width + c];
			}
			horizontal[row * width + col] = sum / span;
		}
	}
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				const r = Math.max(0, Math.min(height - 1, row + k));
				sum += horizontal[r * width + col];
			}
			out[row * width + col] = sum / span;
		}
	}
	return out;
}

function clampInt(value: number, count: number): number {
	return Math.max(0, Math.min(count - 1, value));
}
