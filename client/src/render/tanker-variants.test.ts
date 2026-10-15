import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { tankerDesignFor, tankerShapeKey } from "./tanker-variants";

const entityId = fc.integer({ min: 0, max: 2_000_000 });

describe("tanker variety", () => {
	test.prop([entityId])("the same entity always gets the same tanker", (id) => {
		expect(tankerDesignFor(id)).toEqual(tankerDesignFor(id));
	});

	it("a fleet mixes every tanker class and many liveries", () => {
		const fleet = Array.from({ length: 200 }, (_, i) => tankerDesignFor(i + 1));
		const classes = new Set(fleet.map((d) => d.shape.tankerClass));
		const hulls = new Set(fleet.map((d) => d.livery.hull));
		const funnels = new Set(
			fleet.map((d) => `${d.livery.funnel}/${d.livery.band}`),
		);
		expect(classes.size).toBe(4);
		expect(hulls.size).toBeGreaterThanOrEqual(8);
		expect(funnels.size).toBeGreaterThanOrEqual(8);
	});

	it("crude carriers are the most common class", () => {
		const fleet = Array.from({ length: 500 }, (_, i) => tankerDesignFor(i));
		const crude = fleet.filter((d) => d.shape.tankerClass === "crude").length;
		for (const other of ["product", "lng_moss", "lng_membrane"] as const) {
			expect(crude).toBeGreaterThan(
				fleet.filter((d) => d.shape.tankerClass === other).length,
			);
		}
	});

	test.prop([entityId])(
		"never widens the hull past the collision footprint",
		(id) => {
			expect(tankerDesignFor(id).shape.beamScale).toBeLessThanOrEqual(1);
		},
	);

	test.prop([entityId, entityId])(
		"tankers that share geometry have the same shape",
		(a, b) => {
			const shapeA = tankerDesignFor(a).shape;
			const shapeB = tankerDesignFor(b).shape;
			if (tankerShapeKey(shapeA) !== tankerShapeKey(shapeB)) return;
			expect({ ...shapeA, beamScale: 0 }).toEqual({ ...shapeB, beamScale: 0 });
			expect(Math.abs(shapeA.beamScale - shapeB.beamScale)).toBeLessThanOrEqual(
				0.02,
			);
		},
	);
});
