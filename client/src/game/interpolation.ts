/**
 * Snapshot interpolation — smooth rendering between server ticks.
 *
 * Buffers recent snapshots and renders with a fixed delay so we're always
 * interpolating between two known states (never extrapolating). This
 * eliminates jitter from network variance at the cost of ~100ms visual
 * latency — unnoticeable at 20Hz tick rate.
 */

import type { EntityState } from "./entities";

/** How many snapshots to keep (~500ms at 20Hz). */
const BUFFER_SIZE = 10;

/** Render this far behind real-time (seconds). 2 server ticks. */
const RENDER_DELAY = 0.1;

interface Snapshot {
	time: number;
	entities: Map<number, EntityState>;
}

export class SnapshotInterpolator {
	private buffer: Snapshot[] = [];

	pushSnapshot(entities: Map<number, EntityState>, time: number): void {
		this.buffer.push({
			time,
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

	getInterpolated(entityId: number, renderTime: number): EntityState | null {
		if (this.buffer.length === 0) return null;

		const t0 = renderTime - RENDER_DELAY;
		const i = this.findIndex(t0);
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
		const t = Math.max(0, Math.min((t0 - before.time) / elapsed, 1));

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

	getAllInterpolated(renderTime: number): EntityState[] {
		if (this.buffer.length === 0) return [];

		const t0 = renderTime - RENDER_DELAY;
		const i = this.findIndex(t0);
		const source = this.buffer[i + 1] ?? this.buffer[i];

		const result: EntityState[] = [];
		for (const id of source.entities.keys()) {
			const e = this.getInterpolated(id, renderTime);
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
