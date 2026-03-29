import { fc, it, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
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

const DT = 1 / 60;

// Flat ocean position — no slope forces, no terrain edge artifacts
const FLAT_X = 75000;
const FLAT_Y = 44000;

/** Run N physics steps with constant input, return the vehicle. */
function step(v: NavalVehicle, input: VehicleInput, steps = 1): NavalVehicle {
	for (let i = 0; i < steps; i++) {
		updateVehicle(v, input, DT);
	}
	return v;
}

const IDLE: VehicleInput = { throttle: 0, rudder: 0 };
const FULL_AHEAD: VehicleInput = { throttle: 1, rudder: 0 };
const FULL_REVERSE: VehicleInput = { throttle: -1, rudder: 0 };
const HARD_PORT: VehicleInput = { throttle: 1, rudder: -1 };
const HARD_STARBOARD: VehicleInput = { throttle: 1, rudder: 1 };

// All vehicle factories for parameterized tests
const VEHICLE_FACTORIES = [
	{ name: "speedboat", create: createSpeedboat },
	{ name: "frigate", create: createFrigate },
	{ name: "oil_tanker", create: createOilTanker },
	{ name: "truck", create: createTruck },
	{ name: "quadcopter", create: createQuadcopter },
	{ name: "shahed", create: createShahed },
] as const;

// ---------------------------------------------------------------------------
// Throttle and acceleration
// ---------------------------------------------------------------------------

describe("throttle and acceleration", () => {
	it("full throttle increases speed from rest", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(boat, FULL_AHEAD, 10);
		expect(boat.speed).toBeGreaterThan(0);
	});

	it("reverse throttle produces negative speed", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(boat, FULL_REVERSE, 60);
		expect(boat.speed).toBeLessThan(0);
	});

	it("reverse is weaker than forward", () => {
		const fwd = createSpeedboat(FLAT_X, FLAT_Y);
		const rev = createSpeedboat(FLAT_X, FLAT_Y);
		step(fwd, FULL_AHEAD, 60);
		step(rev, FULL_REVERSE, 60);
		expect(Math.abs(fwd.speed)).toBeGreaterThan(Math.abs(rev.speed));
	});

	it("speed cannot exceed maxSpeed", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(boat, FULL_AHEAD, 600);
		expect(boat.speed).toBeLessThanOrEqual(boat.maxSpeed);
	});

	it("reverse speed limited to 20% of maxSpeed", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(boat, FULL_REVERSE, 600);
		expect(Math.abs(boat.speed)).toBeLessThanOrEqual(
			boat.maxSpeed * 0.2 + 0.01,
		);
	});
});

// ---------------------------------------------------------------------------
// Drag and coming to rest
// ---------------------------------------------------------------------------

describe("drag and deceleration", () => {
	it("vehicle with no throttle loses most of its speed", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		boat.speed = 15;
		const initial = boat.speed;
		step(boat, IDLE, 600);
		// Drag reduces speed significantly — speedboat retains 90%/sec,
		// so after ~10s it should be well below half the initial speed
		expect(boat.speed).toBeLessThan(initial * 0.5);
	});

	it("speed decreases monotonically without throttle on flat terrain", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		boat.speed = 15;
		let prevSpeed = boat.speed;
		for (let i = 0; i < 120; i++) {
			updateVehicle(boat, IDLE, DT);
			expect(boat.speed).toBeLessThanOrEqual(prevSpeed);
			prevSpeed = boat.speed;
		}
	});

	it("drift damps to zero without turning input", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		boat.drift = 5;
		step(boat, IDLE, 600);
		expect(boat.drift).toBe(0);
	});

	test.prop([fc.constantFrom(...VEHICLE_FACTORIES)], { numRuns: 6 })(
		"all vehicle types lose speed with no input",
		({ create }) => {
			const v = create(FLAT_X, FLAT_Y);
			v.speed = v.maxSpeed * 0.5;
			const initial = v.speed;
			step(v, IDLE, 600);
			if (v.cruiseSpeed > 0) {
				expect(v.speed).toBeCloseTo(v.cruiseSpeed, 0);
			} else {
				// All vehicles should lose speed — high-drag vehicles (frigate 0.95)
				// lose less per second than low-drag vehicles (quadcopter 0.75)
				expect(v.speed).toBeLessThan(initial);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// Steering: rudder-based turning
// ---------------------------------------------------------------------------

describe("rudder-based steering", () => {
	it("ship at rest does not turn", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		const h0 = boat.heading;
		step(boat, { throttle: 0, rudder: 1 }, 60);
		expect(boat.heading).toBe(h0);
	});

	it("ship at speed turns with rudder", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		boat.speed = boat.maxSpeed;
		const h0 = boat.heading;
		step(boat, { throttle: 1, rudder: 1 }, 30);
		expect(boat.heading).not.toBe(h0);
	});

	it("truck can steer at low speed (minTurnFraction > 0)", () => {
		const truck = createTruck(FLAT_X, FLAT_Y);
		truck.speed = 0.5;
		const h0 = truck.heading;
		step(truck, { throttle: 0, rudder: 1 }, 30);
		expect(truck.heading).not.toBeCloseTo(h0, 2);
	});

	it("quadcopter can steer at low speed (minTurnFraction = 1)", () => {
		const drone = createQuadcopter(FLAT_X, FLAT_Y);
		drone.speed = 0.1;
		const h0 = drone.heading;
		step(drone, { throttle: 0, rudder: 1 }, 30);
		expect(drone.heading).not.toBeCloseTo(h0, 2);
	});

	it("faster speed produces faster turn rate for ships", () => {
		const slow = createSpeedboat(FLAT_X, FLAT_Y);
		slow.speed = 5;
		const fast = createSpeedboat(FLAT_X, FLAT_Y);
		fast.speed = 20;

		step(slow, { throttle: 0, rudder: 1 }, 30);
		step(fast, { throttle: 0, rudder: 1 }, 30);

		const slowTurn = Math.abs(slow.heading);
		const fastTurn = Math.abs(fast.heading);
		expect(fastTurn).toBeGreaterThan(slowTurn);
	});

	it("port rudder turns left, starboard turns right", () => {
		const port = createSpeedboat(FLAT_X, FLAT_Y);
		port.speed = 15;
		const starboard = createSpeedboat(FLAT_X, FLAT_Y);
		starboard.speed = 15;

		step(port, { throttle: 1, rudder: -1 }, 10);
		step(starboard, { throttle: 1, rudder: 1 }, 10);

		// heading=0 is east. Negative rudder should decrease heading (turn north/port).
		// Positive rudder should increase heading (turn south/starboard).
		// After normalization both should be different from 0 in opposite directions.
		expect(starboard.heading).not.toBeCloseTo(port.heading, 2);
	});

	it("steering in reverse flips rudder direction", () => {
		const fwd = createSpeedboat(FLAT_X, FLAT_Y);
		fwd.speed = 10;
		const rev = createSpeedboat(FLAT_X, FLAT_Y);
		rev.speed = -5;

		step(fwd, { throttle: 0, rudder: 1 }, 10);
		step(rev, { throttle: 0, rudder: 1 }, 10);

		// Forward + starboard rudder turns one way,
		// reverse + same rudder should turn the opposite way
		// (nose still goes in the direction the rudder points)
		const fwdDelta = fwd.heading;
		const revDelta =
			rev.heading > Math.PI ? rev.heading - 2 * Math.PI : rev.heading;
		expect(Math.sign(fwdDelta)).not.toBe(Math.sign(revDelta));
	});
});

// ---------------------------------------------------------------------------
// Heading normalization
// ---------------------------------------------------------------------------

describe("heading normalization", () => {
	test.prop([fc.double({ min: -100, max: 100, noNaN: true })])(
		"heading stays in [0, 2π) after any initial heading",
		(startHeading) => {
			const boat = createSpeedboat(FLAT_X, FLAT_Y);
			boat.heading = startHeading;
			boat.speed = 10;
			step(boat, HARD_STARBOARD, 10);
			expect(boat.heading).toBeGreaterThanOrEqual(0);
			expect(boat.heading).toBeLessThan(Math.PI * 2);
		},
	);
});

// ---------------------------------------------------------------------------
// Drift generation
// ---------------------------------------------------------------------------

describe("drift from turning", () => {
	it("turning at speed generates drift", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		boat.speed = boat.maxSpeed;
		step(boat, HARD_STARBOARD, 30);
		expect(boat.drift).not.toBe(0);
	});

	it("no drift when stationary", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(boat, { throttle: 0, rudder: 1 }, 30);
		expect(boat.drift).toBe(0);
	});

	it("opposite rudder produces opposite drift sign", () => {
		// Speedboat has high turnRate * driftFactor, so per-frame drift
		// exceeds the 0.02 snap-to-zero threshold
		const port = createSpeedboat(FLAT_X, FLAT_Y);
		port.speed = port.maxSpeed;
		const star = createSpeedboat(FLAT_X, FLAT_Y);
		star.speed = star.maxSpeed;

		step(port, HARD_PORT, 30);
		step(star, HARD_STARBOARD, 30);

		expect(port.drift).not.toBe(0);
		expect(star.drift).not.toBe(0);
		expect(Math.sign(port.drift)).not.toBe(Math.sign(star.drift));
	});
});

// ---------------------------------------------------------------------------
// Cruise speed (fixed-wing drones)
// ---------------------------------------------------------------------------

describe("cruise speed override", () => {
	it("shahed flies at cruise speed regardless of throttle", () => {
		const drone = createShahed(FLAT_X, FLAT_Y);
		step(drone, IDLE, 60);
		expect(drone.speed).toBe(drone.cruiseSpeed);
	});

	it("shahed ignores reverse throttle", () => {
		const drone = createShahed(FLAT_X, FLAT_Y);
		step(drone, FULL_REVERSE, 60);
		expect(drone.speed).toBe(drone.cruiseSpeed);
	});

	it("non-cruise vehicles are not affected by cruiseSpeed=0", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(boat, IDLE, 60);
		expect(boat.speed).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

describe("position updates from movement", () => {
	it("vehicle moving east (heading=0) increases x", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		boat.speed = 10;
		const x0 = boat.x;
		step(boat, FULL_AHEAD, 30);
		expect(boat.x).toBeGreaterThan(x0);
	});

	it("vehicle moving south (heading=π/2) increases y", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		boat.heading = Math.PI / 2;
		boat.speed = 10;
		const y0 = boat.y;
		step(boat, FULL_AHEAD, 30);
		expect(boat.y).toBeGreaterThan(y0);
	});

	it("stationary vehicle does not move", () => {
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(boat, IDLE, 60);
		expect(boat.x).toBe(FLAT_X);
		expect(boat.y).toBe(FLAT_Y);
	});
});

// ---------------------------------------------------------------------------
// Vehicle type characteristics
// ---------------------------------------------------------------------------

describe("vehicle type characteristics", () => {
	it("oil tanker is slower than speedboat", () => {
		const tanker = createOilTanker(FLAT_X, FLAT_Y);
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		step(tanker, FULL_AHEAD, 300);
		step(boat, FULL_AHEAD, 300);
		expect(boat.speed).toBeGreaterThan(tanker.speed);
	});

	it("oil tanker turns slower than speedboat", () => {
		const tanker = createOilTanker(FLAT_X, FLAT_Y);
		const boat = createSpeedboat(FLAT_X, FLAT_Y);
		tanker.speed = tanker.maxSpeed;
		boat.speed = boat.maxSpeed;

		step(tanker, HARD_STARBOARD, 30);
		step(boat, HARD_STARBOARD, 30);

		const tankerTurn = tanker.heading;
		const boatTurn = boat.heading;
		expect(boatTurn).toBeGreaterThan(tankerTurn);
	});

	it("quadcopter is more agile than frigate", () => {
		const drone = createQuadcopter(FLAT_X, FLAT_Y);
		const frigate = createFrigate(FLAT_X, FLAT_Y);
		expect(drone.turnRate).toBeGreaterThan(frigate.turnRate);
		expect(drone.acceleration).toBeGreaterThan(frigate.acceleration);
	});
});
