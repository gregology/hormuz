/**
 * Playback clock — which moment of the server's timeline to render.
 *
 * Snapshots carry their server tick, so the states in them are exactly one
 * tick apart. When they arrive is noisy: the server loop, the network, TCP
 * retransmits and a busy main thread all shift it. Rendering on arrival time
 * turned that noise into uneven motion, worst for fast vehicles the camera
 * is locked to.
 *
 * The clock plays the server timeline back at the server's measured pace,
 * just far enough behind it that every recent snapshot would have arrived in
 * time. It reaches that point by running a few percent faster or slower
 * rather than jumping, and never runs past the newest snapshot: if data is
 * late, playback holds and resumes where it left off.
 */

import { TICK_RATE } from "../generated/vehicles";

const TICK_INTERVAL = 1 / TICK_RATE;

/** Margin by which even the latest-arriving recent snapshot should beat playback (seconds). */
const SAFETY_MARGIN = 0.03;

/** How long arrival lateness is remembered when sizing the buffer (seconds). */
const JITTER_WINDOW = 6;

/**
 * Most lateness the buffer will cover (seconds). A gap between arrivals of
 * more than a tick plus this is an outage or a server stall rather than
 * jitter, so measurement restarts instead of adding that much delay to every
 * frame.
 */
const MAX_JITTER = 0.2;

/** Playback runs at most this fraction faster or slower than the server while correcting. */
const MAX_RATE_ADJUST = 0.05;

/** Rate adjustment per second of distance from the target, so corrections settle in ~1 s. */
const CORRECTION_GAIN = 1;

/** Further behind the target than this (seconds), skip ahead instead of speeding up. */
const SKIP_THRESHOLD = 0.3;

/** Arrivals must span this long (seconds) before the server's pace is measured from them. */
const MIN_PACE_SPAN = 1;

interface Arrival {
	serverTime: number;
	clientTime: number;
}

export class PlaybackClock {
	private playback = 0;
	private lastAdvance = 0;
	private arrivals: Arrival[] = [];
	/** Server seconds per client second. */
	private pace = 1;
	/** Target playback time at client time zero; the target then advances at `pace`. */
	private targetOrigin = 0;

	/** Server time being rendered (seconds). */
	get time(): number {
		return this.playback;
	}

	/** Record a snapshot's server time and the client time it arrived (both seconds). */
	observe(serverTime: number, arrival: number): void {
		const newest = this.arrivals.at(-1);
		// The snapshot sent on connect can repeat the last broadcast tick.
		if (newest && serverTime === newest.serverTime) return;
		if (!newest || serverTime < newest.serverTime) {
			this.start(serverTime, arrival);
			return;
		}
		if (arrival - newest.clientTime > TICK_INTERVAL + MAX_JITTER) {
			this.arrivals = [];
		}
		this.arrivals.push({ serverTime, clientTime: arrival });
		while (this.arrivals[0].clientTime < arrival - JITTER_WINDOW) {
			this.arrivals.shift();
		}
		this.measurePace();
		this.aim();
	}

	/** Move playback to this frame's client time (seconds) and return the server time to render. */
	advance(now: number): number {
		const newest = this.arrivals.at(-1);
		if (!newest) return this.playback;

		const elapsed = Math.max(0, now - this.lastAdvance);
		this.lastAdvance = Math.max(this.lastAdvance, now);
		const target = this.targetOrigin + this.pace * now;
		const error = target - this.playback;
		if (error > SKIP_THRESHOLD) {
			this.playback = target;
		} else {
			const adjust = Math.max(
				-MAX_RATE_ADJUST,
				Math.min(MAX_RATE_ADJUST, error * CORRECTION_GAIN),
			);
			this.playback += elapsed * this.pace * (1 + adjust);
		}
		this.playback = Math.min(this.playback, newest.serverTime);
		return this.playback;
	}

	/** First snapshot, or the server restarted: begin a new timeline. */
	private start(serverTime: number, arrival: number): void {
		this.arrivals = [{ serverTime, clientTime: arrival }];
		this.pace = 1;
		this.aim();
		// Nothing is known about jitter yet, so begin with the deepest buffer
		// and let the clock glide towards the target as arrivals are measured.
		this.playback = serverTime - TICK_INTERVAL - SAFETY_MARGIN - MAX_JITTER;
		this.lastAdvance = arrival;
	}

	/**
	 * Track a server that ticks slower (or faster) than nominal, e.g. under
	 * load. Lateness only ever adds delay, so the least-delayed snapshots in
	 * the oldest and newest thirds of the window are the cleanest readings of
	 * the server's clock — a burst of late snapshots can't skew them.
	 */
	private measurePace(): void {
		const start = this.arrivals[0].clientTime;
		const span = this.arrivals[this.arrivals.length - 1].clientTime - start;
		if (span < MIN_PACE_SPAN) return;
		const older = this.leastDelayed(start, start + span / 3);
		const newer = this.leastDelayed(start + (span * 2) / 3, start + span);
		this.pace =
			(newer.serverTime - older.serverTime) /
			(newer.clientTime - older.clientTime);
	}

	/** The snapshot arriving between these client times that was delayed least. */
	private leastDelayed(from: number, to: number): Arrival {
		let best = this.arrivals[0];
		let bestOrigin = Number.NEGATIVE_INFINITY;
		for (const arrival of this.arrivals) {
			if (arrival.clientTime < from || arrival.clientTime > to) continue;
			const origin = this.origin(arrival);
			if (origin > bestOrigin) {
				best = arrival;
				bestOrigin = origin;
			}
		}
		return best;
	}

	/**
	 * The earliest-arriving snapshot is the best estimate of the server's
	 * present; the spread to the latest-arriving one is the jitter to absorb.
	 * Aim that far behind, plus one tick so the next snapshot is in hand to
	 * interpolate towards.
	 */
	private aim(): void {
		let earliest = Number.NEGATIVE_INFINITY;
		let latest = Number.POSITIVE_INFINITY;
		for (const arrival of this.arrivals) {
			const origin = this.origin(arrival);
			earliest = Math.max(earliest, origin);
			latest = Math.min(latest, origin);
		}
		const jitter = Math.min(earliest - latest, MAX_JITTER);
		this.targetOrigin = earliest - jitter - TICK_INTERVAL - SAFETY_MARGIN;
	}

	/** Where an arrival implies the server's timeline stood at client time zero. */
	private origin(arrival: Arrival): number {
		return arrival.serverTime - this.pace * arrival.clientTime;
	}
}
