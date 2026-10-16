/**
 * Cross-host physics contract.
 *
 * The client predicts the player's own vehicle by running input commands
 * through vehicles/controls.ts and vehicles/physics.ts; the server runs the
 * same commands through its ports (server/src/hormuz/controls.py and
 * systems/physics.py). Any difference shows as the player's vehicle being
 * corrected. Both sides replay the scenarios in
 * shared/physics_fixtures.json and must match it tick by tick
 * (server/tests/test_physics_contract.py is the other half).
 *
 * The client is the reference: after an intentional physics or controls
 * change, regenerate with
 *   UPDATE_PHYSICS_FIXTURES=1 pnpm --filter @hormuz/client test -- physics-contract
 * then run the server tests.
 *
 * Scenarios sail in open water, where the client's terrain-slope force is
 * zero (the server leaves slopes out).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../generated/vehicles";
import {
	KEY_FORWARD,
	KEY_LEFT,
	KEY_REVERSE,
	KEY_RIGHT,
	vehicleControls,
} from "./controls";
import { type VehicleType, createVehicle, updateVehicle } from "./physics";

const FIXTURE_PATH = path.resolve(
	import.meta.dirname,
	"../../../shared/physics_fixtures.json",
);
const UPDATE = process.env.UPDATE_PHYSICS_FIXTURES === "1";
const TOLERANCE = 1e-6;
/** States are recorded after every this many ticks; any drift persists, so it still shows. */
const RECORD_EVERY = 5;

/** The same command for `ticks` ticks. */
interface Phase {
	ticks: number;
	keys: number;
	throttle: number;
	nearJammer: boolean;
}

interface Scenario {
	name: string;
	vehicleType: VehicleType;
	start: { x: number; y: number; heading: number };
	phases: Phase[];
	/** x, y, heading, speed, drift, angularVelocity after every RECORD_EVERY ticks. */
	expected?: number[][];
}

function hold(
	ticks: number,
	keys: number,
	throttle = 0,
	nearJammer = false,
): Phase {
	return { ticks, keys, throttle, nearJammer };
}

const OPEN_WATER = { x: 60000, y: 43000, heading: 0.3 };

function shipScenario(vehicleType: VehicleType): Scenario {
	return {
		name: `${vehicleType} throttles up, turns both ways and reverses`,
		vehicleType,
		start: OPEN_WATER,
		phases: [
			hold(30, 0, 0.5),
			hold(40, KEY_LEFT, 1),
			hold(20, 0, 1),
			hold(40, KEY_RIGHT, 0.75),
			hold(30, KEY_LEFT | KEY_RIGHT, -0.5),
			hold(20, KEY_RIGHT, -1),
		],
	};
}

function droneScenario(vehicleType: VehicleType): Scenario {
	return {
		name: `${vehicleType} flies, turns both ways, is jammed and backs off`,
		vehicleType,
		start: OPEN_WATER,
		phases: [
			hold(20, KEY_FORWARD),
			hold(25, KEY_FORWARD | KEY_LEFT),
			hold(10, KEY_FORWARD),
			hold(25, KEY_FORWARD | KEY_RIGHT),
			hold(20, KEY_FORWARD | KEY_LEFT, 0, true),
			hold(20, KEY_REVERSE | KEY_RIGHT),
			hold(20, 0),
		],
	};
}

const SCENARIOS: Scenario[] = [
	shipScenario("oil_tanker"),
	shipScenario("frigate"),
	shipScenario("speedboat"),
	droneScenario("shahed"),
	droneScenario("quadcopter"),
];

/** Mirror of _run_scenario in server/tests/test_physics_contract.py. */
function runScenario(scenario: Scenario): number[][] {
	const vehicle = createVehicle(
		scenario.vehicleType,
		scenario.start.x,
		scenario.start.y,
	);
	vehicle.heading = scenario.start.heading;
	const states: number[][] = [];
	let tick = 0;
	for (const phase of scenario.phases) {
		const controls = vehicleControls(
			scenario.vehicleType,
			phase.keys,
			phase.throttle,
			() => phase.nearJammer,
		);
		for (let i = 0; i < phase.ticks; i++) {
			updateVehicle(vehicle, controls, 1 / TICK_RATE);
			tick++;
			if (tick % RECORD_EVERY !== 0) continue;
			states.push([
				vehicle.x,
				vehicle.y,
				vehicle.heading,
				vehicle.speed,
				vehicle.drift,
				vehicle.angularVelocity,
			]);
		}
	}
	return states;
}

if (UPDATE) {
	const fixtures = SCENARIOS.map((scenario) => ({
		...scenario,
		expected: runScenario(scenario),
	}));
	// One recorded state per line keeps the file short and its diffs readable.
	const json = JSON.stringify(fixtures, null, 2).replace(
		/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g,
		(_, numbers: string) => `[${numbers.split(/,\s+/).join(", ")}]`,
	);
	writeFileSync(FIXTURE_PATH, `${json}\n`);
}

function readFixtures(): Scenario[] {
	try {
		return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Scenario[];
	} catch (cause) {
		throw new Error(
			`Physics fixtures unreadable at ${FIXTURE_PATH}; regenerate with UPDATE_PHYSICS_FIXTURES=1`,
			{ cause },
		);
	}
}

const FIELDS = ["x", "y", "heading", "speed", "drift", "angularVelocity"];
const HEADING = FIELDS.indexOf("heading");

function difference(field: number, a: number, b: number): number {
	// The hosts may write the same angle either side of the 0/2π seam.
	if (field === HEADING)
		return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
	return Math.abs(a - b);
}

describe("physics contract fixtures (client reference)", () => {
	for (const scenario of readFixtures()) {
		it(scenario.name, () => {
			const actual = runScenario(scenario);
			const expected = scenario.expected ?? [];
			expect(actual.length).toBe(expected.length);
			for (const [row, state] of actual.entries()) {
				for (const [i, value] of state.entries()) {
					const tick = (row + 1) * RECORD_EVERY;
					const where = `tick ${tick} ${FIELDS[i]}`;
					expect(difference(i, value, expected[row][i]), where).toBeLessThan(
						TOLERANCE,
					);
				}
			}
		});
	}

	it("covers the scenarios defined here", () => {
		expect(readFixtures().map((s) => s.name)).toEqual(
			SCENARIOS.map((s) => s.name),
		);
	});
});
