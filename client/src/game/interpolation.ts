/**
 * Snapshot interpolation — smooth rendering between server ticks.
 *
 * Stores two consecutive snapshots (prev, current) and interpolates
 * entity positions at render time for 60fps smoothness from 20Hz ticks.
 */

import type { EntityState } from "./entities";

export class SnapshotInterpolator {
	private prev = new Map<number, EntityState>();
	private current = new Map<number, EntityState>();
	private prevTime = 0;
	private currentTime = 0;

	pushSnapshot(entities: Map<number, EntityState>, time: number): void {
		this.prev = this.current;
		this.prevTime = this.currentTime;
		this.current = new Map([...entities].map(([id, e]) => [id, { ...e }]));
		this.currentTime = time;
	}

	getInterpolated(entityId: number, renderTime: number): EntityState | null {
		const curr = this.current.get(entityId);
		if (!curr) return null;

		const prev = this.prev.get(entityId);
		if (!prev || this.currentTime <= this.prevTime) return curr;

		const elapsed = this.currentTime - this.prevTime;
		const t = Math.min((renderTime - this.prevTime) / elapsed, 1.5);

		return {
			...curr,
			x: prev.x + (curr.x - prev.x) * t,
			y: prev.y + (curr.y - prev.y) * t,
			heading: lerpAngle(prev.heading, curr.heading, t),
			speed: prev.speed + (curr.speed - prev.speed) * t,
			drift: prev.drift + (curr.drift - prev.drift) * t,
		};
	}

	getAllInterpolated(renderTime: number): EntityState[] {
		const result: EntityState[] = [];
		for (const id of this.current.keys()) {
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
