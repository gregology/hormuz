import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../generated/vehicles";
import { CommandClock } from "./command-clock";

/**
 * Commands issued over `seconds` of frames at `fps`, while the server
 * reports holding `held` commands at every tick.
 */
function issued(
	clock: CommandClock,
	seconds: number,
	options: { fps?: number; held?: number; start?: number } = {},
): number {
	const { fps = 60, held = 1, start = 0 } = options;
	let count = 0;
	let nextReport = start;
	for (let now = start; now < start + seconds; now += 1 / fps) {
		while (nextReport <= now) {
			clock.observeBuffered(held);
			nextReport += 1 / TICK_RATE;
		}
		count += clock.due(now);
	}
	return count;
}

describe("command clock", () => {
	it("issues one command per server tick whatever the frame rate", () => {
		for (const fps of [30, 60, 144]) {
			const count = issued(new CommandClock(), 10, { fps });
			expect(Math.abs(count - 10 * TICK_RATE)).toBeLessThanOrEqual(1);
		}
	});

	it("keeps pace with a server ticking slower than nominal", () => {
		const clock = new CommandClock();
		clock.setPace(0.9);
		const count = issued(clock, 10);
		expect(Math.abs(count - 9 * TICK_RATE)).toBeLessThanOrEqual(1);
	});

	it("runs a little ahead while the server has no command waiting", () => {
		const clock = new CommandClock();
		issued(clock, 5, { held: 0 });
		expect(issued(clock, 10, { held: 0, start: 5 })).toBeGreaterThan(
			10 * TICK_RATE + 2,
		);
	});

	it("falls back while the server holds a backlog", () => {
		const clock = new CommandClock();
		issued(clock, 5, { held: 3 });
		expect(issued(clock, 10, { held: 3, start: 5 })).toBeLessThan(
			10 * TICK_RATE - 4,
		);
	});

	it("resumes after a long pause instead of sending a burst", () => {
		const clock = new CommandClock();
		issued(clock, 1);
		expect(clock.due(6)).toBeLessThanOrEqual(3);
		expect(issued(clock, 1, { start: 6.01 })).toBeLessThanOrEqual(
			TICK_RATE + 1,
		);
	});
});
