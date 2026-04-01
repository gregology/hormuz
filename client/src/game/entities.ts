/**
 * Client-side entity state store.
 */

import type { FullSnapshot } from "../net/protocol";

export interface EntityState {
	id: number;
	vehicleType: string;
	faction: string;
	x: number;
	y: number;
	heading: number;
	speed: number;
	drift: number;
	hp: number;
	angularVelocity: number;
	floodLevel?: number;
	listAngle?: number;
	batteryPct?: number;
}

export class EntityStore {
	entities = new Map<number, EntityState>();

	applySnapshot(snapshot: FullSnapshot): void {
		this.entities.clear();
		for (const e of snapshot.entities) {
			this.entities.set(e.id, { ...e });
		}
	}
}
