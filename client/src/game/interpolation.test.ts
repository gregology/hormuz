import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../generated/vehicles";
import {
	type VehicleInput,
	createVehicle,
	updateVehicle,
} from "../vehicles/physics";
import type { EntityState } from "./entities";
import { SnapshotInterpolator } from "./interpolation";

const TICK = 1 / TICK_RATE;

/** Snapshots of a quadcopter flying with these controls, one per tick. */
function flight(controls: VehicleInput[]): EntityState[] {
	const quad = createVehicle("quadcopter", 60000, 43000);
	quad.speed = 30;
	return controls.map((input, tick) => {
		if (tick > 0) updateVehicle(quad, input, TICK);
		return {
			id: 1,
			vehicleType: "quadcopter",
			faction: "iran",
			x: quad.x,
			y: quad.y,
			heading: quad.heading,
			speed: quad.speed,
			drift: quad.drift,
			hp: 13,
			angularVelocity: quad.angularVelocity,
		};
	});
}

function interpolatorOf(states: EntityState[]): SnapshotInterpolator {
	const interpolator = new SnapshotInterpolator();
	for (const [tick, state] of states.entries()) {
		interpolator.pushSnapshot(new Map([[1, state]]), tick * TICK);
	}
	return interpolator;
}

function positionAt(interpolator: SnapshotInterpolator, time: number) {
	const e = interpolator.getInterpolated(1, time);
	if (!e) throw new Error(`nothing at ${time}`);
	return e;
}

function directionAt(interpolator: SnapshotInterpolator, time: number): number {
	const a = positionAt(interpolator, time - 1e-4);
	const b = positionAt(interpolator, time + 1e-4);
	return Math.atan2(b.y - a.y, b.x - a.x);
}

const hardLeft = Array.from({ length: 12 }, () => ({
	throttle: 1,
	rudder: -1,
}));

describe("snapshot interpolation", () => {
	test.prop([
		fc.array(
			fc.record({
				throttle: fc.constantFrom(-1, 0, 1),
				rudder: fc.constantFrom(-1, 0, 1),
			}),
			{ minLength: 3, maxLength: 15 },
		),
	])("passes through every snapshot", (controls) => {
		const states = flight(controls);
		const interpolator = interpolatorOf(states);
		for (const [tick, state] of states.entries()) {
			const drawn = positionAt(interpolator, tick * TICK);
			expect(drawn.x).toBeCloseTo(state.x, 9);
			expect(drawn.y).toBeCloseTo(state.y, 9);
		}
	});

	it("turns a hard-turning drone smoothly through each snapshot, without a corner", () => {
		const interpolator = interpolatorOf(flight(hardLeft));
		for (let tick = 2; tick < 10; tick++) {
			const before = directionAt(interpolator, tick * TICK - 2e-4);
			const after = directionAt(interpolator, tick * TICK + 2e-4);
			// A straight-line path turns a whole tick's worth (0.2 rad) here.
			expect(Math.abs(after - before)).toBeLessThan(0.005);
		}
	});

	it("moves a vehicle pushed aside by a collision straight to where it was pushed", () => {
		const states = flight(hardLeft.slice(0, 4));
		states[3] = { ...states[3], y: states[3].y + 3 };
		const interpolator = interpolatorOf(states);
		const [from, to] = [states[2], states[3]];
		for (const fraction of [0.25, 0.5, 0.75]) {
			const drawn = positionAt(interpolator, (2 + fraction) * TICK);
			const offLine =
				((to.x - from.x) * (drawn.y - from.y) -
					(to.y - from.y) * (drawn.x - from.x)) /
				Math.hypot(to.x - from.x, to.y - from.y);
			expect(Math.abs(offLine)).toBeLessThan(1e-9);
		}
	});

	it("changes hit points when playback reaches the snapshot that carries them", () => {
		const states = flight(hardLeft.slice(0, 3));
		states[2] = { ...states[2], hp: 0 };
		const interpolator = interpolatorOf(states);
		expect(positionAt(interpolator, 1.9 * TICK).hp).toBe(13);
		expect(positionAt(interpolator, 2 * TICK).hp).toBe(0);
	});
});
