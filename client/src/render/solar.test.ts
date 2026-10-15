import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
	atStraitHour,
	formatStraitTime,
	straitSolarPosition,
	sunDirection,
} from "./solar";

const anyInstant = fc.date({
	min: new Date("2000-01-01T00:00:00Z"),
	max: new Date("2100-01-01T00:00:00Z"),
	noInvalidDate: true,
});

describe("sun over the strait", () => {
	it("is nearly overhead at solar noon on the June solstice", () => {
		// Strait centre is ~56.3°E, so solar noon is ~08:16 UTC.
		const noon = straitSolarPosition(new Date("2026-06-21T08:16:00Z"));
		expect(noon.elevation).toBeGreaterThan(86);
	});

	it("stands due south at solar noon in December", () => {
		const noon = straitSolarPosition(new Date("2026-12-21T08:14:00Z"));
		expect(noon.azimuth).toBeGreaterThan(178);
		expect(noon.azimuth).toBeLessThan(182);
		expect(noon.elevation).toBeCloseTo(90 - 26.75 - 23.44, 0);
	});

	it("is below the horizon at local midnight", () => {
		const midnight = straitSolarPosition(new Date("2026-06-21T20:16:00Z"));
		expect(midnight.elevation).toBeLessThan(-30);
	});

	it("rises in the east-northeast in June", () => {
		let minute = 0;
		let position = straitSolarPosition(new Date("2026-06-21T00:00:00Z"));
		while (position.elevation < 0 && minute < 24 * 60) {
			minute++;
			position = straitSolarPosition(
				new Date(Date.UTC(2026, 5, 21, 0, minute)),
			);
		}
		expect(position.azimuth).toBeGreaterThan(58);
		expect(position.azimuth).toBeLessThan(70);
		// Sunrise in the strait in late June is around 05:10 local (UTC+4).
		expect(
			formatStraitTime(new Date(Date.UTC(2026, 5, 21, 0, minute))),
		).toMatch(/^05:/);
	});

	test.prop([anyInstant])("always reports a valid sky position", (date) => {
		const { elevation, azimuth } = straitSolarPosition(date);
		expect(elevation).toBeGreaterThanOrEqual(-90);
		expect(elevation).toBeLessThanOrEqual(90);
		expect(azimuth).toBeGreaterThanOrEqual(0);
		expect(azimuth).toBeLessThan(360);
	});

	test.prop([anyInstant])(
		"direction is a unit vector whose height matches elevation",
		(date) => {
			const position = straitSolarPosition(date);
			const [x, y, z] = sunDirection(position);
			expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
			expect(y).toBeCloseTo(Math.sin((position.elevation * Math.PI) / 180), 9);
		},
	);

	it("points east (+X) when the sun is due east", () => {
		const [x, y, z] = sunDirection({ elevation: 0, azimuth: 90 });
		expect(x).toBeCloseTo(1);
		expect(y).toBeCloseTo(0);
		expect(z).toBeCloseTo(0);
	});

	it("points north (-Z) when the sun is due north", () => {
		const [, , z] = sunDirection({ elevation: 0, azimuth: 0 });
		expect(z).toBeCloseTo(-1);
	});
});

describe("strait clock", () => {
	it("shows Gulf Standard Time (UTC+4)", () => {
		expect(formatStraitTime(new Date("2026-06-21T20:00:00Z"))).toBe("00:00");
		expect(formatStraitTime(new Date("2026-06-21T13:45:00Z"))).toBe("17:45");
	});

	test.prop([
		anyInstant,
		fc.integer({ min: 0, max: 23 }),
		fc.integer({ min: 0, max: 59 }),
	])(
		"atStraitHour lands on the requested local time of the same local day",
		(date, hour, minute) => {
			const result = atStraitHour(date, hour + minute / 60);
			const expected = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
			expect(formatStraitTime(new Date(result.getTime() + 1000))).toBe(
				expected,
			);
			expect(Math.abs(result.getTime() - date.getTime())).toBeLessThan(
				86_400_000,
			);
		},
	);
});
