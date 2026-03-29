/**
 * Terrain classification using coastline polygon data.
 *
 * Uses ray-casting point-in-polygon tests against the Natural Earth
 * coastline boundaries — the same data that the renderer draws.
 * A point is "land" if it falls inside any Iran coast, Arabian coast,
 * or island polygon.
 */

import {
	ARABIAN_COAST_POLYS,
	IRAN_COAST_POLYS,
	ISLAND_POLYGONS,
} from "./coastlines";
import type { Polygon } from "./data";

// Collect all land polygons once at module load
const LAND_POLYS: Polygon[] = [
	...IRAN_COAST_POLYS,
	...ARABIAN_COAST_POLYS,
	...ISLAND_POLYGONS.map((isl) => isl.polygon),
];

// Pre-compute bounding boxes for early rejection
interface BBox {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

const BBOXES: BBox[] = LAND_POLYS.map((poly) => {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of poly) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, maxX, minY, maxY };
});

/**
 * Ray-casting algorithm: cast a ray in +x from (px, py) and count
 * how many polygon edges it crosses. Odd = inside, even = outside.
 */
function pointInPolygon(poly: Polygon, px: number, py: number): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i][0];
		const yi = poly[i][1];
		const xj = poly[j][0];
		const yj = poly[j][1];

		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/** Returns true if the world position (x, y) is on land. */
export function isLand(x: number, y: number): boolean {
	for (let i = 0; i < LAND_POLYS.length; i++) {
		const bb = BBOXES[i];
		if (x < bb.minX || x > bb.maxX || y < bb.minY || y > bb.maxY) continue;
		if (pointInPolygon(LAND_POLYS[i], x, y)) return true;
	}
	return false;
}

/** Returns true if the world position (x, y) is in water. */
export function isWater(x: number, y: number): boolean {
	return !isLand(x, y);
}
