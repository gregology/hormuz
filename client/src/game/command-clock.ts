/**
 * When to issue input commands.
 *
 * The server applies one command per tick (server/src/hormuz/commands.py),
 * so the client issues them at the server's tick rate: the pace
 * `PlaybackClock` measures, trimmed by a few percent from the server's
 * reports of how many commands it is holding. Holding about one absorbs
 * network jitter at the cost of a tick of delay. Holding none means a late
 * command made the server reuse the last one, and the prediction of the
 * player's vehicle has to be corrected; holding more only delays input.
 */

import { TICK_RATE } from "../generated/vehicles";

const TICK_INTERVAL = 1 / TICK_RATE;

/** Commands the server should be holding after each tick. */
const TARGET_BUFFERED = 1;

/** Weight of each report in the smoothed count of held commands. */
const BUFFERED_SMOOTHING = 0.05;

/** Rate adjustment per command away from the target. */
const RATE_GAIN = 0.02;

/** Commands go out at most this fraction faster or slower than the server ticks. */
const MAX_RATE_ADJUST = 0.05;

/**
 * Most commands issued in one frame. After a longer pause (a hidden tab) the
 * clock resumes from now rather than sending a burst the server would skip.
 */
const MAX_BURST = 3;

export class CommandClock {
	private next: number | null = null;
	private interval = TICK_INTERVAL;
	private pace = 1;
	private buffered = TARGET_BUFFERED;

	/** Server seconds per client second, as measured by `PlaybackClock`. */
	setPace(pace: number): void {
		this.pace = pace;
	}

	/** The server's report of how many of this client's commands it is holding. */
	observeBuffered(count: number): void {
		this.buffered += (count - this.buffered) * BUFFERED_SMOOTHING;
	}

	/** How many commands to issue at client time `now` (seconds). */
	due(now: number): number {
		if (this.next === null) this.next = now;
		let count = 0;
		while (this.next <= now && count < MAX_BURST) {
			count++;
			this.interval = this.currentInterval();
			this.next += this.interval;
		}
		if (this.next <= now) this.next = now + this.interval;
		return count;
	}

	/** How far client time `now` is from the last command to the next, 0–1. */
	fraction(now: number): number {
		if (this.next === null) return 1;
		const since = now - (this.next - this.interval);
		return Math.max(0, Math.min(since / this.interval, 1));
	}

	private currentInterval(): number {
		const adjust = Math.max(
			-MAX_RATE_ADJUST,
			Math.min(MAX_RATE_ADJUST, (TARGET_BUFFERED - this.buffered) * RATE_GAIN),
		);
		return TICK_INTERVAL / (this.pace * (1 + adjust));
	}
}
