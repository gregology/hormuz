import { describe, expect, it } from "vitest";
import {
	IRAN_SPAWNS,
	LANE_INBOUND,
	LANE_OUTBOUND,
	MAP,
	TANKER_SPAWNS,
	US_BASES,
	US_SPAWNS,
} from "./data";
import { isLand, isWater } from "./terrain";

// ---------------------------------------------------------------------------
// Map bounds
// ---------------------------------------------------------------------------

describe("map dimensions", () => {
	it("has positive width and height", () => {
		expect(MAP.width).toBeGreaterThan(0);
		expect(MAP.height).toBeGreaterThan(0);
	});

	it("center is within bounds", () => {
		expect(MAP.center.x).toBeGreaterThan(0);
		expect(MAP.center.x).toBeLessThan(MAP.width);
		expect(MAP.center.y).toBeGreaterThan(0);
		expect(MAP.center.y).toBeLessThan(MAP.height);
	});
});

// ---------------------------------------------------------------------------
// All spawn points within map bounds
// ---------------------------------------------------------------------------

describe("spawn points are within map bounds", () => {
	const allSpawns = [
		...US_SPAWNS,
		...IRAN_SPAWNS,
		...TANKER_SPAWNS,
		...US_BASES,
	];
	for (const spawn of allSpawns) {
		it(`"${spawn.label}" is within map bounds`, () => {
			const [x, y] = spawn.position;
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(MAP.width);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(MAP.height);
		});
	}
});

// ---------------------------------------------------------------------------
// Spawn terrain classification
// ---------------------------------------------------------------------------

describe("US bases are on land", () => {
	for (const base of US_BASES) {
		it(`"${base.label}" is on land`, () => {
			const [x, y] = base.position;
			expect(isLand(x, y)).toBe(true);
		});
	}
});

describe("naval spawns are in water", () => {
	// Filter out Gulf of Oman edge-of-map spawns and Qatar (on the peninsula)
	const navalSpawns = [
		...US_SPAWNS.filter(
			(s) => !s.label.includes("Gulf of Oman") && !s.label.includes("Qatar"),
		),
		...TANKER_SPAWNS.filter((s) => !s.label.includes("Gulf of Oman")),
	];

	for (const spawn of navalSpawns) {
		it(`"${spawn.label}" is in water`, () => {
			const [x, y] = spawn.position;
			expect(isWater(x, y)).toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// Shipping lanes are in water
// ---------------------------------------------------------------------------

describe("shipping lanes are in water", () => {
	for (let i = 0; i < LANE_INBOUND.length; i++) {
		it(`inbound lane waypoint ${i} is in water`, () => {
			const [x, y] = LANE_INBOUND[i];
			expect(isWater(x, y)).toBe(true);
		});
	}

	for (let i = 0; i < LANE_OUTBOUND.length; i++) {
		it(`outbound lane waypoint ${i} is in water`, () => {
			const [x, y] = LANE_OUTBOUND[i];
			expect(isWater(x, y)).toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// Headings are valid radians
// ---------------------------------------------------------------------------

describe("spawn headings are valid", () => {
	const allSpawns = [
		...US_SPAWNS,
		...IRAN_SPAWNS,
		...TANKER_SPAWNS,
		...US_BASES,
	];
	for (const spawn of allSpawns) {
		it(`"${spawn.label}" heading is a finite number`, () => {
			expect(Number.isFinite(spawn.heading)).toBe(true);
		});
	}
});
