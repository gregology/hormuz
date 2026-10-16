/**
 * When to send player input. The server reads input once per tick, so
 * sending every rendered frame (60–144 Hz) only loaded its event loop and
 * slowed the tick for everyone. Changes go out at once to keep controls
 * responsive; unchanged input repeats at the tick rate as a steady stream.
 */

import { TICK_RATE } from "../generated/vehicles";

const REPEAT_INTERVAL = 1 / TICK_RATE;

export interface PlayerInput {
	keys: number;
	throttle: number;
	autopilot: boolean;
}

export class InputThrottle {
	private last: PlayerInput | null = null;
	private nextRepeat = Number.NEGATIVE_INFINITY;

	/** Whether to send this input at client time `now` (seconds); if so it counts as sent. */
	shouldSend(input: PlayerInput, now: number): boolean {
		const changed =
			this.last === null ||
			this.last.keys !== input.keys ||
			this.last.throttle !== input.throttle ||
			this.last.autopilot !== input.autopilot;
		const due = now >= this.nextRepeat;
		if (!changed && !due) return false;

		this.last = { ...input };
		if (due) {
			// Repeats stay on a fixed grid so frame timing can't alias them
			// below the tick rate (at 144 fps, "a tick since the last send"
			// lands on every eighth frame: 18 Hz).
			this.nextRepeat += REPEAT_INTERVAL;
			if (this.nextRepeat <= now) this.nextRepeat = now + REPEAT_INTERVAL;
		}
		return true;
	}
}
