import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../generated/vehicles";
import {
	type VehicleInput,
	createVehicle,
	updateVehicle,
} from "../vehicles/physics";
import type { EntityState } from "./entities";
import { type Motion, angleBetween } from "./motion";
import { VehiclePredictor } from "./prediction";

const TICK = 1 / TICK_RATE;
/** Ticks a command takes to reach the server, and a snapshot to come back. */
const LATENCY = 2;

const AHEAD = { throttle: 1, rudder: 0 };
const LEFT = { throttle: 1, rudder: -1 };
const RIGHT = { throttle: 1, rudder: 1 };
const MANOEUVRES: VehicleInput[] = [
	...Array(10).fill(AHEAD),
	...Array(10).fill(LEFT),
	...Array(5).fill(AHEAD),
	...Array(15).fill(RIGHT),
];

const START = { x: 60000, y: 43000 };

/**
 * Fly `controls`, one command per tick, through a predictor and a server
 * that applies one command per tick (as server/src/hormuz/commands.py does),
 * `LATENCY` ticks away each way. `disturb` changes the server's vehicle in
 * ways the client can't foresee.
 */
function fly(
	controls: VehicleInput[],
	disturb: (tick: number, vehicle: Motion) => void = () => {},
) {
	const predictor = new VehiclePredictor();
	predictor.follow(1, "quadcopter");
	const server = createVehicle("quadcopter", START.x, START.y);
	let serverControls: VehicleInput = { throttle: 0, rudder: 0 };
	let lastApplied = 0;
	const toServer: { at: number; sequence: number; input: VehicleInput }[] = [];
	const toClient: { at: number; state: EntityState; lastCommand: number }[] =
		[];
	/** Where the vehicle is drawn after each tick, once its first snapshot has arrived. */
	const drawn: (Motion | null)[] = [];
	const reconciled: { tick: number; before: Motion; after: Motion }[] = [];

	for (const [tick, input] of controls.entries()) {
		for (const snapshot of toClient.filter((s) => s.at === tick)) {
			const before = predictor.pose(1);
			predictor.reconcile(snapshot.state, snapshot.lastCommand, 1);
			const after = predictor.pose(1);
			if (before && after) reconciled.push({ tick, before, after });
		}
		const sequence = tick + 1;
		predictor.apply(sequence, input);
		toServer.push({ at: tick + LATENCY, sequence, input });

		const arrived = toServer.find((c) => c.at === tick);
		if (arrived) {
			serverControls = arrived.input;
			lastApplied = arrived.sequence;
		}
		updateVehicle(server, serverControls, TICK);
		disturb(tick, server);
		toClient.push({
			at: tick + LATENCY,
			state: { ...server, id: 1, faction: "iran", hp: 13 },
			lastCommand: lastApplied,
		});

		predictor.settle(TICK);
		drawn.push(predictor.pose(1));
	}
	return { drawn, reconciled };
}

/** The same flight with no network at all: where each command should put the vehicle. */
function ideal(controls: VehicleInput[]): Motion[] {
	const vehicle = createVehicle("quadcopter", START.x, START.y);
	return controls.map((input) => {
		updateVehicle(vehicle, input, TICK);
		return { ...vehicle };
	});
}

const jump = (a: Motion, b: Motion) => Math.hypot(a.x - b.x, a.y - b.y);

function drawnAt(pose: Motion | null | undefined): Motion {
	if (!pose) throw new Error("vehicle not drawn yet");
	return pose;
}

describe("own-vehicle prediction", () => {
	it("moves the vehicle the moment a command is issued, not a round trip later", () => {
		const { drawn } = fly(MANOEUVRES);
		const expected = ideal(MANOEUVRES);
		const firstTurn = 10;
		const turning = drawnAt(drawn[firstTurn]);
		const before = drawnAt(drawn[firstTurn - 1]);
		expect(
			angleBetween(turning.heading, expected[firstTurn].heading),
		).toBeCloseTo(0, 9);
		expect(
			Math.abs(angleBetween(before.heading, turning.heading)),
		).toBeGreaterThan(0.1);
	});

	it("follows exactly the path the server will take when nothing unforeseen happens", () => {
		const { drawn, reconciled } = fly(MANOEUVRES);
		const expected = ideal(MANOEUVRES);
		for (const [tick, pose] of drawn.entries()) {
			if (tick < LATENCY) expect(pose).toBeNull();
			else expect(jump(drawnAt(pose), expected[tick])).toBeLessThan(1e-9);
		}
		expect(reconciled.length).toBeGreaterThan(30);
	});

	it("takes an unforeseen push out of view gradually rather than jumping", () => {
		const pushedAt = 15;
		const { drawn, reconciled } = fly(MANOEUVRES, (tick, vehicle) => {
			if (tick === pushedAt) vehicle.y += 2;
		});
		const correction = reconciled.find((r) => r.tick === pushedAt + LATENCY);
		if (!correction) throw new Error("push never reached the client");
		expect(jump(correction.before, correction.after)).toBeLessThan(1e-9);

		const expected = ideal(MANOEUVRES);
		const settled = drawnAt(drawn[pushedAt + LATENCY + 10]);
		const pushed = expected[pushedAt + LATENCY + 10];
		expect(Math.abs(settled.y - pushed.y - 2)).toBeLessThan(0.05);
	});

	it("jumps straight to a respawn far away", () => {
		const respawnAt = 15;
		const { reconciled } = fly(MANOEUVRES, (tick, vehicle) => {
			if (tick === respawnAt) vehicle.x += 5000;
		});
		const respawn = reconciled.find((r) => r.tick === respawnAt + LATENCY);
		if (!respawn) throw new Error("respawn never reached the client");
		expect(respawn.after.x - respawn.before.x).toBeGreaterThan(4900);
	});
});
