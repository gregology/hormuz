/**
 * Three.js effect manager — lifecycle management for all visual effects.
 *
 * Owns a THREE.Group added to the scene graph. Handles two categories:
 *   - Continuous effects (wake trails, stern churn) tied to entity state
 *   - Transient effects (explosions, sinking) that run independently
 *
 * Effects own Three.js objects that render automatically in the scene.
 */

import * as THREE from "three";
import type { EntityState } from "../game/entities";
import { Explosion } from "./explosion";
import { Sinking } from "./sinking";
import { SternChurn } from "./stern-churn";
import type { ThreeEffect } from "./types";
import { WakeTrail } from "./wake-trail";

// Vehicle defaults needed for effect generation
const VEHICLE_DEFAULTS: Record<
	string,
	{ size: number; airborne: boolean; equilibriumSpeed: number }
> = {
	oil_tanker: { size: 220, airborne: false, equilibriumSpeed: 15 },
	shahed: { size: 4, airborne: true, equilibriumSpeed: 80 },
	speedboat: { size: 10, airborne: false, equilibriumSpeed: 26 },
	frigate: { size: 100, airborne: false, equilibriumSpeed: 13.5 },
	truck: { size: 5, airborne: false, equilibriumSpeed: 18 },
	quadcopter: { size: 2, airborne: true, equilibriumSpeed: 22 },
};

// Faction -> render color (duplicated from main.ts to avoid circular dep)
const FACTION_COLORS: Record<string, number> = {
	civilian: 0xf39c12,
	iran: 0x27ae60,
	us: 0x2980b9,
};

export class ThreeEffectManager {
	readonly root: THREE.Group;
	private transientEffects: ThreeEffect[] = [];
	private wakeTrails = new Map<number, WakeTrail>();
	private sternChurns = new Map<number, SternChurn>();
	private previousHp = new Map<number, number>();

	constructor() {
		this.root = new THREE.Group();
	}

	/** Spawn an explosion effect at the given world position. */
	spawnExplosion(x: number, y: number, radius = 60): void {
		const effect = new Explosion(x, y, radius);
		this.transientEffects.push(effect);
		this.root.add(effect.root);
	}

	/** Spawn a sinking effect for a destroyed vehicle. */
	spawnSinking(
		x: number,
		y: number,
		heading: number,
		size: number,
		color: number,
		floodLevel = 0,
		listAngle = 0,
	): void {
		const effect = new Sinking(x, y, heading, size, color, floodLevel, listAngle);
		this.transientEffects.push(effect);
		this.root.add(effect.root);
	}

	/**
	 * Update all effects. Call once per frame with interpolated entities.
	 * Zoom is needed for screen-pixel-to-world-unit conversions.
	 */
	update(entities: EntityState[], dt: number, zoom: number): void {
		const activeIds = new Set<number>();

		for (const e of entities) {
			const defaults = VEHICLE_DEFAULTS[e.vehicleType];
			if (!defaults) continue;

			activeIds.add(e.id);

			// Detect death: hp was positive, now zero or negative
			const prevHp = this.previousHp.get(e.id) ?? e.hp;
			if (prevHp > 0 && e.hp <= 0) {
				const color = FACTION_COLORS[e.faction] ?? 0xcccccc;
				this.spawnSinking(
					e.x,
					e.y,
					e.heading,
					defaults.size,
					color,
					e.floodLevel ?? 0,
					e.listAngle ?? 0,
				);
				// Clear wake/churn so respawn doesn't draw a line artifact
				this.removeWake(e.id);
				this.removeChurn(e.id);
			}
			this.previousHp.set(e.id, e.hp);

			// Skip dead, airborne, or truck entities for water effects
			if (e.hp <= 0 || defaults.airborne || e.vehicleType === "truck")
				continue;

			// Wake trail
			let wake = this.wakeTrails.get(e.id);
			if (!wake) {
				wake = new WakeTrail(e.id);
				this.wakeTrails.set(e.id, wake);
				this.root.add(wake.root);
			}
			wake.feed(e.x, e.y, e.heading, e.speed, defaults.size, dt);

			// Stern churn
			let churn = this.sternChurns.get(e.id);
			if (!churn) {
				churn = new SternChurn(e.id);
				this.sternChurns.set(e.id, churn);
				this.root.add(churn.root);
			}
			churn.feed(
				e.x,
				e.y,
				e.heading,
				e.speed,
				defaults.equilibriumSpeed,
				defaults.size,
				dt,
			);
		}

		// Remove effects for entities that no longer exist
		for (const [id] of this.wakeTrails) {
			if (!activeIds.has(id)) this.removeWake(id);
		}
		for (const [id] of this.sternChurns) {
			if (!activeIds.has(id)) this.removeChurn(id);
		}
		for (const [id] of this.previousHp) {
			if (!activeIds.has(id)) this.previousHp.delete(id);
		}

		// Update all continuous effects
		for (const [, wake] of this.wakeTrails) {
			wake.update(dt, zoom);
		}
		for (const [, churn] of this.sternChurns) {
			churn.update(dt, zoom);
		}

		// Update transient effects, remove dead ones
		for (const effect of this.transientEffects) {
			effect.update(dt, zoom);
		}
		const dead = this.transientEffects.filter((e) => !e.alive);
		for (const effect of dead) {
			this.root.remove(effect.root);
			effect.dispose();
		}
		this.transientEffects = this.transientEffects.filter((e) => e.alive);
	}

	private removeWake(id: number): void {
		const wake = this.wakeTrails.get(id);
		if (wake) {
			this.root.remove(wake.root);
			wake.dispose();
			this.wakeTrails.delete(id);
		}
	}

	private removeChurn(id: number): void {
		const churn = this.sternChurns.get(id);
		if (churn) {
			this.root.remove(churn.root);
			churn.dispose();
			this.sternChurns.delete(id);
		}
	}

	/** Clean up all GPU resources. */
	dispose(): void {
		for (const [, wake] of this.wakeTrails) {
			this.root.remove(wake.root);
			wake.dispose();
		}
		for (const [, churn] of this.sternChurns) {
			this.root.remove(churn.root);
			churn.dispose();
		}
		for (const effect of this.transientEffects) {
			this.root.remove(effect.root);
			effect.dispose();
		}
		this.wakeTrails.clear();
		this.sternChurns.clear();
		this.transientEffects = [];
	}
}
