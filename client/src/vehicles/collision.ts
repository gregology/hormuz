/**
 * Collision detection and resolution for vehicles.
 *
 * Terrain collisions use the coastline polygon data (Natural Earth
 * boundaries) — the same geometry the renderer draws. This ensures
 * collision boundaries match what the player sees on screen.
 *
 * Vehicle collisions use circle-circle overlap with mass-weighted pushback.
 */

import { isLand, isWater } from "../map/terrain";
import type { NavalVehicle } from "./physics";

// Minimum collision radius so tiny vehicles (drones) aren't too small to hit.
const MIN_COLLISION_RADIUS = 4;

/**
 * Check and resolve terrain collisions for a single vehicle.
 * Call after updateVehicle() with the position from before the update.
 * Returns true if a collision occurred.
 */
export function resolveTerrainCollision(
	v: NavalVehicle,
	prevX: number,
	prevY: number,
): boolean {
	if (v.airborne) return false;

	let blocked = false;

	if (
		v.vehicleType === "speedboat" ||
		v.vehicleType === "frigate" ||
		v.vehicleType === "oil_tanker"
	) {
		blocked = isLand(v.x, v.y);
	} else if (v.vehicleType === "truck") {
		blocked = isWater(v.x, v.y);
	}

	if (!blocked) return false;

	// Revert to previous position and kill forward momentum
	v.x = prevX;
	v.y = prevY;
	v.speed *= -0.3;
	v.drift = 0;
	return true;
}

/**
 * Detect and resolve all pairwise vehicle-vehicle collisions.
 * Uses circle collision with radius proportional to vehicle size.
 * Pushback is weighted by relative mass (size).
 */
export function resolveVehicleCollisions(vehicles: NavalVehicle[]): void {
	for (let i = 0; i < vehicles.length; i++) {
		for (let j = i + 1; j < vehicles.length; j++) {
			const a = vehicles[i];
			const b = vehicles[j];

			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const distSq = dx * dx + dy * dy;

			const ra = Math.max(a.size * 0.4, MIN_COLLISION_RADIUS);
			const rb = Math.max(b.size * 0.4, MIN_COLLISION_RADIUS);
			const minDist = ra + rb;

			if (distSq >= minDist * minDist || distSq === 0) continue;

			const dist = Math.sqrt(distSq);
			const overlap = minDist - dist;
			const nx = dx / dist;
			const ny = dy / dist;

			// Mass-weighted separation (heavier vehicles move less)
			const totalSize = a.size + b.size;
			const pushA = overlap * (b.size / totalSize);
			const pushB = overlap * (a.size / totalSize);

			a.x -= nx * pushA;
			a.y -= ny * pushA;
			b.x += nx * pushB;
			b.y += ny * pushB;

			// Speed reduction — lighter vehicle loses more speed
			const sizeRatio = Math.min(a.size, b.size) / Math.max(a.size, b.size);
			const dampA =
				a.size <= b.size
					? 0.3 + sizeRatio * 0.55 // light: 0.3 (tiny vs huge) to 0.85 (equal)
					: 0.85;
			const dampB = b.size <= a.size ? 0.3 + sizeRatio * 0.55 : 0.85;

			a.speed *= dampA;
			b.speed *= dampB;
			a.drift *= dampA;
			b.drift *= dampB;
		}
	}
}
