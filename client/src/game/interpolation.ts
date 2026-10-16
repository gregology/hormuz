/**
 * Snapshot interpolation — entity state at any moment between two snapshots.
 *
 * Snapshots are keyed by server time (tick / TICK_RATE), not by when they
 * arrived, so states one tick apart on the server stay one tick apart here.
 * `PlaybackClock` decides which moment to render; this only interpolates
 * between known states, never extrapolates.
 */

import { TICK_RATE } from "../generated/vehicles";
import type { EntityState } from "./entities";

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
		if (!after) return eBefore ?? null;

		const eAfter = after.entities.get(entityId);
		if (!eBefore) return eAfter ?? null;
		if (!eAfter) return eBefore;

		const elapsed = after.time - before.time;
		if (elapsed <= 0) return eAfter;

		// Clamp to [0,1] — pure interpolation, no extrapolation
		const t = Math.max(0, Math.min((serverTime - before.time) / elapsed, 1));

		return {
			...eAfter,
			x: eBefore.x + (eAfter.x - eBefore.x) * t,
			y: eBefore.y + (eAfter.y - eBefore.y) * t,
			heading: lerpAngle(eBefore.heading, eAfter.heading, t),
			speed: eBefore.speed + (eAfter.speed - eBefore.speed) * t,
			drift: eBefore.drift + (eAfter.drift - eBefore.drift) * t,
			angularVelocity:
				eBefore.angularVelocity +
				(eAfter.angularVelocity - eBefore.angularVelocity) * t,
		};
	}

	getAllInterpolated(serverTime: number): EntityState[] {
		if (this.buffer.length === 0) return [];

		const i = this.findIndex(serverTime);
		const source = this.buffer[i + 1] ?? this.buffer[i];

		const result: EntityState[] = [];
		for (const id of source.entities.keys()) {
			const e = this.getInterpolated(id, serverTime);
			if (e) result.push(e);
		}
		return result;
	}
}

/** Shortest-arc angle interpolation. */
function lerpAngle(a: number, b: number, t: number): number {
	let diff = b - a;
	// Normalize to [-pi, pi]
	diff = ((diff + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return a + diff * t;
}
