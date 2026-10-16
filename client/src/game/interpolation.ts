/**
 * Snapshot interpolation — entity state at any moment between two snapshots.
 *
 * Snapshots are keyed by server time (tick / TICK_RATE), not by when they
 * arrived, so states one tick apart on the server stay one tick apart here.
 * `PlaybackClock` decides which moment to render; this only interpolates
 * between known states, never extrapolates. Positions follow smooth curves
 * (`motion.ts`). Discrete state such as hit points changes when playback
 * reaches the snapshot that carries it, the same moment events from that
 * tick play, so a drone vanishes as its explosion goes off.
 */

import { TICK_RATE } from "../generated/vehicles";
import type { EntityState } from "./entities";
import { headingBetween, positionBetween } from "./motion";

/** How many snapshots to keep: one second, more than the playback clock ever buffers. */
const BUFFER_SIZE = TICK_RATE;

interface Snapshot {
	time: number;
	entities: Map<number, EntityState>;
}

export class SnapshotInterpolator {
	private buffer: Snapshot[] = [];

	pushSnapshot(entities: Map<number, EntityState>, serverTime: number): void {
		const newest = this.buffer.at(-1);
		// The snapshot sent on connect can repeat the last broadcast tick.
		if (newest && serverTime === newest.time) return;
		// Server time going backwards means the server restarted.
		if (newest && serverTime < newest.time) this.buffer = [];

		this.buffer.push({
			time: serverTime,
			entities: new Map([...entities].map(([id, e]) => [id, { ...e }])),
		});
		if (this.buffer.length > BUFFER_SIZE) {
			this.buffer.shift();
		}
	}

	/** Index of the last snapshot at or before the given time. */
	private findIndex(t: number): number {
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			if (this.buffer[i].time <= t) return i;
		}
		return 0;
	}

	getInterpolated(entityId: number, serverTime: number): EntityState | null {
		if (this.buffer.length === 0) return null;

		const i = this.findIndex(serverTime);
		const before = this.buffer[i];
		const after = this.buffer[i + 1];

		const eBefore = before.entities.get(entityId);
		if (!eBefore) return null;
		const eAfter = after?.entities.get(entityId);
		if (!eAfter) return eBefore;

		const elapsed = after.time - before.time;
		// Clamp to [0,1] — pure interpolation, no extrapolation
		const t = Math.max(0, Math.min((serverTime - before.time) / elapsed, 1));
		const eEarlier = this.buffer[i - 1]?.entities.get(entityId);

		return {
			...eBefore,
			...positionBetween(eEarlier, eBefore, eAfter, t, elapsed),
			heading: headingBetween(eBefore.heading, eAfter.heading, t),
			speed: eBefore.speed + (eAfter.speed - eBefore.speed) * t,
			drift: eBefore.drift + (eAfter.drift - eBefore.drift) * t,
			angularVelocity:
				eBefore.angularVelocity +
				(eAfter.angularVelocity - eBefore.angularVelocity) * t,
		};
	}

	getAllInterpolated(serverTime: number): EntityState[] {
		if (this.buffer.length === 0) return [];

		const source = this.buffer[this.findIndex(serverTime)];
		const result: EntityState[] = [];
		for (const id of source.entities.keys()) {
			const e = this.getInterpolated(id, serverTime);
			if (e) result.push(e);
		}
		return result;
	}
}
