import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../generated/vehicles";
import { InputThrottle, type PlayerInput } from "./input-throttle";

const idle: PlayerInput = { keys: 0, throttle: 0, autopilot: false };
const turningLeft: PlayerInput = { keys: 0x04, throttle: 0, autopilot: false };

describe("input throttle", () => {
	it("sends a change at once, even right after a repeat", () => {
		const throttle = new InputThrottle();
		expect(throttle.shouldSend(idle, 10)).toBe(true);
		expect(throttle.shouldSend(turningLeft, 10.01)).toBe(true);
	});

	it.each([60, 144])(
		"repeats unchanged input at the tick rate, not the %i fps frame rate",
		(fps) => {
			const throttle = new InputThrottle();
			let sent = 0;
			for (let frame = 0; frame < 10 * fps; frame++) {
				if (throttle.shouldSend(idle, 100 + frame / fps)) sent++;
			}
			expect(sent).toBeGreaterThanOrEqual(10 * TICK_RATE - 1);
			expect(sent).toBeLessThanOrEqual(10 * TICK_RATE + 1);
		},
	);
});
