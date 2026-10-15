import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { Polygon } from "../generated/map_data";
import {
	getCoastField,
	rasterizePolygons,
	sampleField,
	signedDistanceField,
} from "./coast-field";
import { isLand } from "./terrain";

const field = getCoastField();
const { grid } = field;

const anyCell = fc.record({
	col: fc.integer({ min: 0, max: grid.width - 1 }),
	row: fc.integer({ min: 0, max: grid.height - 1 }),
});

describe("coast field over the game map", () => {
	test.prop([anyCell])(
		"its sign agrees with isLand at every cell centre",
		({ col, row }) => {
			const x = (col + 0.5) * grid.cellSize;
			const y = (row + 0.5) * grid.cellSize;
			const distance = field.signedDistance[row * grid.width + col];
			expect(distance < 0).toBe(isLand(x, y));
		},
	);

	it("is far from land in the open Gulf of Oman", () => {
		expect(
			sampleField(field.signedDistance, grid, 105000, 60000),
		).toBeGreaterThan(5000);
	});

	it("is deep inland in the Iranian interior", () => {
		expect(sampleField(field.signedDistance, grid, 75000, 20000)).toBeLessThan(
			-5000,
		);
	});

	it("keeps depth-zone masks within 0..1", () => {
		for (const mask of [field.shallow, field.veryShallow, field.shoal]) {
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			for (const v of mask) {
				min = Math.min(min, v);
				max = Math.max(max, v);
			}
			expect(min).toBeGreaterThanOrEqual(0);
			expect(max).toBeLessThanOrEqual(1 + 1e-6);
			expect(max).toBeGreaterThan(0.5);
		}
	});
});

describe("signed distance of a known shape", () => {
	// A 2000×2000 square island centred in a 6000×6000 sea.
	const square: Polygon = [
		[2000, 2000],
		[4000, 2000],
		[4000, 4000],
		[2000, 4000],
	];
	const smallGrid = { width: 60, height: 60, cellSize: 100 };
	const sdf = signedDistanceField([square], smallGrid);

	test.prop([fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 })])(
		"matches the exact distance to the square's edge",
		(col, row) => {
			const x = (col + 0.5) * 100;
			const y = (row + 0.5) * 100;
			const dx = Math.max(2000 - x, 0, x - 4000);
			const dy = Math.max(2000 - y, 0, y - 4000);
			const outside = Math.hypot(dx, dy);
			const inside = Math.min(x - 2000, 4000 - x, y - 2000, 4000 - y);
			const expected = outside > 0 ? outside : -inside;
			// Exact near the coast, transform-accurate (within a cell) far from it.
			const tolerance = Math.abs(expected) <= 400 ? 1e-3 : 100;
			expect(Math.abs(sdf[row * 60 + col] - expected)).toBeLessThanOrEqual(
				tolerance,
			);
		},
	);

	it("rasterizes the cells whose centres fall inside", () => {
		const mask = rasterizePolygons([square], smallGrid);
		const count = mask.reduce((sum, v) => sum + v, 0);
		expect(count).toBe(20 * 20);
	});
});
