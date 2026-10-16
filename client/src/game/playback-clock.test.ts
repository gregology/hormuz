import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../generated/vehicles";
import type { EntityState } from "./entities";
import { SnapshotInterpolator } from "./interpolation";
import { PlaybackClock } from "./playback-clock";

const FRAME = 1 / 60;
/** A shahed at full speed, in world units per second of server time. */
const SPEED = 80;

interface Network {
	/** One-way delay of snapshot `index` (seconds). */
	delay: (index: number) => number;
	/** Server ticks per wall-clock second; an overloaded server runs slow. */
	tickRate?: number;
	/** Tick number carried by snapshot `index`. */
	tick?: (index: number) => number;
}

interface Frame {
	/** Client time of the frame (seconds). */
	now: number;
	/** Rendered vehicle position along its track. */
	x: number;
	/** Server time rendered. */
	time: number;
	/** Server time of the newest snapshot received. */
	newest: number;
}

function vehicleAt(serverTime: number): Map<number, EntityState> {
	const vehicle: EntityState = {
		id: 1,
		vehicleType: "shahed",
		faction: "iran",
		x: SPEED * serverTime,
		y: 0,
		heading: 0,
		speed: SPEED,
		drift: 0,
		hp: 1,
		angularVelocity: 0,
	};
	return new Map([[1, vehicle]]);
}

/** Stream a vehicle flying at constant speed through a network and render it at 60 fps. */
function play(seconds: number, network: Network): Frame[] {
	const tickRate = network.tickRate ?? TICK_RATE;
	const tick = network.tick ?? ((index: number) => index);
	// TCP delivers in order, so a late snapshot holds back the ones behind it.
	const arrivals: number[] = [];
	let previous = 0;
	for (let i = 0; i < seconds * tickRate; i++) {
		previous = Math.max(previous, i / tickRate + network.delay(i));
		arrivals.push(previous);
	}

	const clock = new PlaybackClock();
	const interpolator = new SnapshotInterpolator();
	const frames: Frame[] = [];
	let next = 0;
	let newest = 0;
	for (let k = 0; k < seconds / FRAME; k++) {
		const now = k * FRAME;
		while (next < arrivals.length && arrivals[next] <= now) {
			newest = tick(next) / TICK_RATE;
			interpolator.pushSnapshot(vehicleAt(newest), newest);
			clock.observe(newest, arrivals[next]);
			next++;
		}
		const time = clock.advance(now);
		const vehicle = interpolator.getInterpolated(1, time);
		if (vehicle) frames.push({ now, x: vehicle.x, time, newest });
	}
	return frames;
}

/** How far the vehicle moved each frame, as a fraction of how far it really flew. */
function frameSteps(
	frames: Frame[],
	from: number,
	to = Number.POSITIVE_INFINITY,
): number[] {
	const window = frames.filter((f) => f.now >= from && f.now < to);
	return window
		.slice(1)
		.map((f, i) => (f.x - window[i].x) / (SPEED * (f.now - window[i].now)));
}

/** Mean distance between the newest snapshot and what is on screen (seconds). */
function meanLag(
	frames: Frame[],
	from: number,
	to = Number.POSITIVE_INFINITY,
): number {
	const window = frames.filter((f) => f.now >= from && f.now < to);
	return window.reduce((sum, f) => sum + f.newest - f.time, 0) / window.length;
}

/** Deterministic random numbers (mulberry32), so a failure reproduces exactly. */
function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 40 ms of latency plus up to `jitter` seconds of noise, clustered around the middle. */
function jitteryNetwork(jitter: number, seed = 1): (index: number) => number {
	const random = seededRandom(seed);
	return () => 0.04 + (jitter * (random() + random() + random())) / 3;
}

describe("snapshot playback", () => {
	it("moves a fast vehicle evenly however unevenly its snapshots arrive", () => {
		const frames = play(60, { delay: jitteryNetwork(0.04) });
		const steps = frameSteps(frames, 10);
		expect(Math.min(...steps)).toBeGreaterThan(0.9);
		expect(Math.max(...steps)).toBeLessThan(1.1);
	});

	it("keeps pace with a server ticking slower than nominal", () => {
		const tickRate = TICK_RATE * 0.9;
		const frames = play(60, { delay: jitteryNetwork(0.02), tickRate });
		const steps = frameSteps(frames, 15).map((s) => s / 0.9);
		expect(Math.min(...steps)).toBeGreaterThan(0.9);
		expect(Math.max(...steps)).toBeLessThan(1.1);
	});

	it("stays further behind on a jittery connection than on a clean one", () => {
		const clean = meanLag(play(30, { delay: () => 0.04 }), 15);
		const jittery = meanLag(play(30, { delay: jitteryNetwork(0.08) }), 15);
		expect(clean).toBeLessThan(2 / TICK_RATE);
		expect(jittery).toBeGreaterThan(clean + 0.03);
	});

	it("holds through a network outage, then resumes smoothly near the live stream", () => {
		const outage = { start: 20, end: 21 };
		const frames = play(40, {
			delay: (index) => {
				const sent = index / TICK_RATE;
				const stuck = sent >= outage.start && sent < outage.end;
				return 0.04 + (stuck ? outage.end - sent : 0);
			},
		});
		expect(meanLag(frames, outage.end + 0.2, outage.end + 1)).toBeLessThan(0.3);
		const steps = frameSteps(frames, outage.end + 0.2);
		expect(Math.min(...steps)).toBeGreaterThan(0.9);
		expect(Math.max(...steps)).toBeLessThan(1.1);
		expect(meanLag(frames, outage.end + 15)).toBeLessThan(0.15);
	});

	it("follows the server's timeline after its tick counter restarts", () => {
		const restartAt = 10 * TICK_RATE;
		const frames = play(15, {
			delay: () => 0.04,
			tick: (index) => (index < restartAt ? 5000 + index : index - restartAt),
		});
		const last = frames[frames.length - 1];
		expect(last.time).toBeLessThan(last.newest);
		expect(last.newest - last.time).toBeLessThan(0.3);
	});

	test.prop([
		fc.array(fc.double({ min: 0, max: 0.5, noNaN: true }), {
			minLength: 2,
			maxLength: 200,
		}),
		fc.array(fc.double({ min: 0.001, max: 0.3, noNaN: true }), {
			minLength: 1,
			maxLength: 50,
		}),
	])(
		"never plays backwards or past the newest snapshot",
		(delays, frameIntervals) => {
			let previousArrival = 0;
			const arrivals = delays.map((delay, i) => {
				previousArrival = Math.max(previousArrival, i / TICK_RATE + delay);
				return previousArrival;
			});
			const clock = new PlaybackClock();
			let now = 0;
			let next = 0;
			let previous = Number.NEGATIVE_INFINITY;
			for (let k = 0; next < arrivals.length; k++) {
				now += frameIntervals[k % frameIntervals.length];
				while (next < arrivals.length && arrivals[next] <= now) {
					clock.observe(next / TICK_RATE, arrivals[next]);
					next++;
				}
				const time = clock.advance(now);
				if (next === 0) continue;
				expect(time).toBeGreaterThanOrEqual(previous);
				expect(time).toBeLessThanOrEqual((next - 1) / TICK_RATE);
				previous = time;
			}
		},
	);
});
