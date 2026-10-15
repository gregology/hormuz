import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { getCoastField, sampleField } from "../map/coast-field";
import { MAP } from "../map/data";
import { getElevation } from "../map/heightmap";
import {
	COAST_RAMP_DISTANCE,
	TERRAIN_BASE_HEIGHT,
	terrainSurfaceHeight,
} from "./terrain-surface";

const field = getCoastField();
const anyPoint = fc.record({
	x: fc.double({ min: 0, max: MAP.width, noNaN: true }),
	y: fc.double({ min: 0, max: MAP.height, noNaN: true }),
});

describe("rendered terrain surface", () => {
	test.prop([anyPoint])("never dips to the sea surface", ({ x, y }) => {
		expect(terrainSurfaceHeight(x, y)).toBeGreaterThanOrEqual(
			TERRAIN_BASE_HEIGHT,
		);
	});

	test.prop([anyPoint])(
		"follows the gameplay heightmap away from the coast",
		({ x, y }) => {
			const inland = -sampleField(field.signedDistance, field.grid, x, y);
			if (inland < COAST_RAMP_DISTANCE) return;
			expect(terrainSurfaceHeight(x, y)).toBeCloseTo(
				getElevation(x, y) + TERRAIN_BASE_HEIGHT,
				6,
			);
		},
	);

	test.prop([anyPoint])(
		"never rises above the gameplay heightmap",
		({ x, y }) => {
			expect(terrainSurfaceHeight(x, y)).toBeLessThanOrEqual(
				Math.max(getElevation(x, y), 0) + TERRAIN_BASE_HEIGHT + 1e-9,
			);
		},
	);
});
