import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { daylightFor } from "./daylight";

const elevation = fc.double({ min: -90, max: 90, noNaN: true });

describe("daylight palette", () => {
	it("has no direct sunlight once the sun is well below the horizon", () => {
		expect(daylightFor(-10).sunIntensity).toBe(0);
	});

	it("switches ship lights on at night and off at midday", () => {
		expect(daylightFor(-20).artificialLights).toBeCloseTo(1);
		expect(daylightFor(60).artificialLights).toBeCloseTo(0);
	});

	it("keeps ambient light at night so the game stays playable", () => {
		const night = daylightFor(-40);
		expect(night.ambientIntensity).toBeGreaterThan(0.5);
		expect(Math.max(...night.skyColor)).toBeGreaterThan(0.05);
	});

	it("reddens the sun near the horizon", () => {
		const sunset = daylightFor(1).sunColor;
		const noon = daylightFor(70).sunColor;
		expect(sunset[2] / sunset[0]).toBeLessThan(noon[2] / noon[0]);
	});

	test.prop([elevation, elevation])(
		"gets brighter, never darker, as the sun climbs",
		(a, b) => {
			const [low, high] = a <= b ? [a, b] : [b, a];
			expect(daylightFor(high).daylight).toBeGreaterThanOrEqual(
				daylightFor(low).daylight,
			);
			expect(daylightFor(high).sunIntensity).toBeGreaterThanOrEqual(
				daylightFor(low).sunIntensity - 1e-9,
			);
			expect(daylightFor(high).artificialLights).toBeLessThanOrEqual(
				daylightFor(low).artificialLights,
			);
		},
	);
});
