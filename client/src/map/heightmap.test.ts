import { fc, it, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
	HEIGHTMAP_CELL_SIZE,
	HEIGHTMAP_HEIGHT,
	HEIGHTMAP_WIDTH,
	getElevation,
	getRawElevation,
	getSlopeAlongHeading,
	getTerrainGradient,
} from "./heightmap";

// ---------------------------------------------------------------------------
// Grid metadata
// ---------------------------------------------------------------------------

describe("heightmap grid", () => {
	it("has positive dimensions", () => {
		expect(HEIGHTMAP_WIDTH).toBeGreaterThan(0);
		expect(HEIGHTMAP_HEIGHT).toBeGreaterThan(0);
		expect(HEIGHTMAP_CELL_SIZE).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Elevation queries
// ---------------------------------------------------------------------------

describe("getRawElevation", () => {
	it("returns 0 for deep ocean", () => {
		// center of the strait — should be water (elevation 0)
		expect(getRawElevation(75000, 44000)).toBe(0);
	});

	it("returns positive value for known land", () => {
		// interior Iran
		expect(getRawElevation(75000, 38000)).toBeGreaterThan(0);
	});

	it("clamps to grid bounds without crashing", () => {
		expect(() => getRawElevation(-10000, -10000)).not.toThrow();
		expect(() => getRawElevation(999999, 999999)).not.toThrow();
	});
});

describe("getElevation (bilinear interpolation)", () => {
	it("matches raw value at grid cell center", () => {
		// Sample at a grid-aligned point
		const col = 50;
		const row = 30;
		const x = (col + 0.5) * HEIGHTMAP_CELL_SIZE;
		const y = (row + 0.5) * HEIGHTMAP_CELL_SIZE;

		const raw = getRawElevation(x, y);
		const interp = getElevation(x, y);

		expect(interp).toBeCloseTo(raw, 0);
	});

	it("is continuous — nearby points have similar values", () => {
		const x = 75000;
		const y = 38000;
		const e0 = getElevation(x, y);
		const e1 = getElevation(x + 1, y);
		const e2 = getElevation(x, y + 1);

		// 1 game-unit apart should produce very small elevation differences
		expect(Math.abs(e1 - e0)).toBeLessThan(10);
		expect(Math.abs(e2 - e0)).toBeLessThan(10);
	});

	test.prop(
		[
			fc.double({
				min: 0,
				max: HEIGHTMAP_WIDTH * HEIGHTMAP_CELL_SIZE,
				noNaN: true,
			}),
			fc.double({
				min: 0,
				max: HEIGHTMAP_HEIGHT * HEIGHTMAP_CELL_SIZE,
				noNaN: true,
			}),
		],
		{ numRuns: 50 },
	)("never returns NaN for any in-bounds position", (x, y) => {
		const e = getElevation(x, y);
		expect(Number.isNaN(e)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Gradient queries
// ---------------------------------------------------------------------------

describe("getTerrainGradient", () => {
	it("gradient is near zero over flat ocean", () => {
		const grad = getTerrainGradient(75000, 44000);
		expect(Math.abs(grad.dx)).toBeLessThan(0.01);
		expect(Math.abs(grad.dy)).toBeLessThan(0.01);
	});

	it("gradient is non-zero on sloped terrain", () => {
		// Near the Iranian coast where elevation transitions from 0 to land
		// Try a few points to find one on a slope
		const candidates = [
			[75000, 39500],
			[75000, 40000],
			[75000, 40500],
		];

		let foundSlope = false;
		for (const [x, y] of candidates) {
			const grad = getTerrainGradient(x, y);
			if (Math.abs(grad.dx) > 0.001 || Math.abs(grad.dy) > 0.001) {
				foundSlope = true;
				break;
			}
		}
		expect(foundSlope).toBe(true);
	});
});

describe("getSlopeAlongHeading", () => {
	it("opposite headings give opposite slopes", () => {
		// Pick a point on a slope (near coast)
		const x = 75000;
		const y = 39500;

		const north = getSlopeAlongHeading(x, y, -Math.PI / 2);
		const south = getSlopeAlongHeading(x, y, Math.PI / 2);

		// If there's any slope, opposite directions must have opposite sign
		if (Math.abs(north) > 0.001) {
			expect(Math.sign(north)).toBe(-Math.sign(south));
		}
	});

	it("returns zero on flat terrain", () => {
		const slope = getSlopeAlongHeading(75000, 44000, 0);
		expect(Math.abs(slope)).toBeLessThan(0.01);
	});
});
