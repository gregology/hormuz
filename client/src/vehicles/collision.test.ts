import { describe, expect, it } from "vitest";
import { isLand, isWater } from "../map/terrain";
import { resolveTerrainCollision, resolveVehicleCollisions } from "./collision";
import {
	type NavalVehicle,
	type VehicleInput,
	createFrigate,
	createOilTanker,
	createQuadcopter,
	createShahed,
	createSpeedboat,
	createTruck,
	updateVehicle,
} from "./physics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate N steps of physics + collision for a single vehicle. */
function simulate(
	v: NavalVehicle,
	input: VehicleInput,
	steps: number,
	dt = 1 / 60,
): void {
	for (let i = 0; i < steps; i++) {
		const prevX = v.x;
		const prevY = v.y;
		updateVehicle(v, input, dt);
		resolveTerrainCollision(v, prevX, prevY);
	}
}

// Spawn positions (must match playground/src/main.ts)
const SPEEDBOAT_SPAWN = [75746, 42781] as const;
const FRIGATE_SPAWN = [75540, 43226] as const;
const TANKER_SPAWN = [75500, 43000] as const;
const TRUCK_SPAWN = [75698, 42649] as const;

// ---------------------------------------------------------------------------
// Terrain classifier sanity — verify coastline polygons classify correctly
// ---------------------------------------------------------------------------

describe("terrain classifier", () => {
	it("open strait is water", () => {
		expect(isWater(75000, 44000)).toBe(true);
	});

	it("interior Iran is land", () => {
		expect(isLand(75000, 38000)).toBe(true);
	});

	it("speedboat spawn is in water", () => {
		expect(isWater(...SPEEDBOAT_SPAWN)).toBe(true);
	});

	it("frigate spawn is in water", () => {
		expect(isWater(...FRIGATE_SPAWN)).toBe(true);
	});

	it("tanker spawn is in water", () => {
		expect(isWater(...TANKER_SPAWN)).toBe(true);
	});

	it("truck spawn is on land", () => {
		expect(isLand(...TRUCK_SPAWN)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Terrain collisions — ships stay in water, trucks stay on land
// ---------------------------------------------------------------------------

describe("ships cannot go on land", () => {
	it("speedboat on clear land is blocked", () => {
		const boat = createSpeedboat(75000, 38000);
		expect(resolveTerrainCollision(boat, boat.x, boat.y)).toBe(true);
	});

	it("speedboat in open water is not blocked", () => {
		const boat = createSpeedboat(75000, 44000);
		expect(resolveTerrainCollision(boat, boat.x, boat.y)).toBe(false);
	});

	it("speedboat at spawn is not blocked", () => {
		const boat = createSpeedboat(...SPEEDBOAT_SPAWN);
		expect(resolveTerrainCollision(boat, boat.x, boat.y)).toBe(false);
	});

	it("frigate on clear land is blocked", () => {
		const ship = createFrigate(75000, 38000);
		expect(resolveTerrainCollision(ship, ship.x, ship.y)).toBe(true);
	});

	it("oil tanker on clear land is blocked", () => {
		const ship = createOilTanker(75000, 38000);
		expect(resolveTerrainCollision(ship, ship.x, ship.y)).toBe(true);
	});

	it("blocked ship reverts to previous position", () => {
		const boat = createSpeedboat(75000, 38000); // on land
		const prevX = 75000;
		const prevY = 44000; // previous was water
		boat.speed = 10;

		resolveTerrainCollision(boat, prevX, prevY);

		expect(boat.x).toBe(prevX);
		expect(boat.y).toBe(prevY);
		expect(boat.speed).toBeCloseTo(-3);
	});

	it("speedboat driving north toward Iran stays in water", () => {
		const boat = createSpeedboat(...SPEEDBOAT_SPAWN);
		boat.heading = -Math.PI / 2; // north

		simulate(boat, { throttle: 1, rudder: 0 }, 600);

		expect(isWater(boat.x, boat.y)).toBe(true);
	});

	it("speedboat driving east stays in water", () => {
		const boat = createSpeedboat(...SPEEDBOAT_SPAWN);
		boat.heading = 0;

		simulate(boat, { throttle: 1, rudder: 0 }, 600);

		expect(isWater(boat.x, boat.y)).toBe(true);
	});
});

describe("trucks cannot enter water", () => {
	it("truck in open water is blocked", () => {
		const truck = createTruck(75000, 44000);
		expect(resolveTerrainCollision(truck, truck.x, truck.y)).toBe(true);
	});

	it("truck on land is not blocked", () => {
		const truck = createTruck(...TRUCK_SPAWN);
		expect(resolveTerrainCollision(truck, truck.x, truck.y)).toBe(false);
	});

	it("blocked truck reverts to previous position", () => {
		const truck = createTruck(75000, 44000); // water
		const prevX = 75000;
		const prevY = 38000; // land
		truck.speed = 10;

		resolveTerrainCollision(truck, prevX, prevY);

		expect(truck.x).toBe(prevX);
		expect(truck.y).toBe(prevY);
		expect(truck.speed).toBeCloseTo(-3);
	});

	it("truck driving toward water stays on land", () => {
		const truck = createTruck(...TRUCK_SPAWN);
		truck.heading = Math.PI; // west toward water

		simulate(truck, { throttle: 1, rudder: 0 }, 600);

		expect(isLand(truck.x, truck.y)).toBe(true);
	});

	it("truck driving in any direction stays on land", () => {
		const headings = [
			0,
			Math.PI / 4,
			Math.PI / 2,
			(3 * Math.PI) / 4,
			Math.PI,
			(-3 * Math.PI) / 4,
			-Math.PI / 2,
			-Math.PI / 4,
		];

		for (const heading of headings) {
			const truck = createTruck(...TRUCK_SPAWN);
			truck.heading = heading;

			simulate(truck, { throttle: 1, rudder: 0 }, 600);

			expect(isLand(truck.x, truck.y)).toBe(true);
		}
	});
});

describe("airborne vehicles ignore terrain", () => {
	it("quadcopter over land is not blocked", () => {
		const drone = createQuadcopter(75000, 38000);
		expect(resolveTerrainCollision(drone, drone.x, drone.y)).toBe(false);
	});

	it("quadcopter over water is not blocked", () => {
		const drone = createQuadcopter(75000, 44000);
		expect(resolveTerrainCollision(drone, drone.x, drone.y)).toBe(false);
	});

	it("shahed over land is not blocked", () => {
		const drone = createShahed(75000, 38000);
		expect(resolveTerrainCollision(drone, drone.x, drone.y)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Vehicle-vehicle collisions
// ---------------------------------------------------------------------------

describe("vehicle-vehicle collisions", () => {
	it("overlapping vehicles are pushed apart", () => {
		const a = createSpeedboat(100, 100);
		const b = createSpeedboat(101, 100);
		a.speed = 10;
		b.speed = 5;

		resolveVehicleCollisions([a, b]);

		expect(b.x - a.x).toBeGreaterThan(1);
	});

	it("distant vehicles are not affected", () => {
		const a = createSpeedboat(100, 100);
		const b = createSpeedboat(200, 200);
		a.speed = 10;

		resolveVehicleCollisions([a, b]);

		expect(a.x).toBe(100);
		expect(b.x).toBe(200);
		expect(a.speed).toBe(10);
	});

	it("heavy vehicle barely moves when hit by light vehicle", () => {
		const drone = createQuadcopter(100, 100);
		const tanker = createOilTanker(101, 100);

		const tankerOrigX = tanker.x;
		resolveVehicleCollisions([drone, tanker]);

		expect(Math.abs(tanker.x - tankerOrigX)).toBeLessThan(1);
		expect(Math.abs(drone.x - 100)).toBeGreaterThan(1);
	});

	it("drone collides with ship within collision range", () => {
		const drone = createQuadcopter(100, 100);
		const frigate = createFrigate(103, 100);
		drone.speed = 20;

		resolveVehicleCollisions([drone, frigate]);

		expect(drone.speed).toBeLessThan(20);
	});
});
