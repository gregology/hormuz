/**
 * Effect manager — lifecycle management for all visual effects.
 *
 * Owns a PixiJS Container with a Graphics child for procedural drawing.
 * Handles two categories:
 *   - Continuous effects (wake trails, stern churn) tied to entity state
 *   - Transient effects (explosions, sinking) that run independently
 */

import { Container, Graphics } from "pixi.js";
import type { EntityState } from "../game/entities";
import type { Camera } from "../render/camera";
import type { VehicleType } from "../vehicles/physics";
import { Explosion } from "./explosion";
import { Sinking } from "./sinking";
import { SternChurn } from "./stern-churn";
import type { Effect } from "./types";
import { WakeTrail } from "./wake-trail";

// Vehicle defaults needed for effect generation
const VEHICLE_DEFAULTS: Record<
	string,
	{ size: number; airborne: boolean; maxSpeed: number }
> = {
	oil_tanker: { size: 220, airborne: false, maxSpeed: 7.5 },
	shahed: { size: 4, airborne: true, maxSpeed: 40 },
	speedboat: { size: 10, airborne: false, maxSpeed: 26 },
	frigate: { size: 100, airborne: false, maxSpeed: 13.5 },
	truck: { size: 5, airborne: false, maxSpeed: 18 },
	quadcopter: { size: 2, airborne: true, maxSpeed: 22 },
};

// Faction -> render color (duplicated from main.ts to avoid circular dep)
const FACTION_COLORS: Record<string, number> = {
	civilian: 0xf39c12,
	iran: 0x27ae60,
	us: 0x2980b9,
};

export class EffectManager {
	private container: Container;
	private graphics: Graphics;
	private transientEffects: Effect[] = [];
	private wakeTrails = new Map<number, WakeTrail>();
	private sternChurns = new Map<number, SternChurn>();
	private previousHp = new Map<number, number>();

	constructor() {
		this.container = new Container();
		this.graphics = new Graphics();
		this.container.addChild(this.graphics);
	}

	getContainer(): Container {
		return this.container;
	}

	/** Spawn an explosion effect at the given world position. */
	spawnExplosion(x: number, y: number, radius = 60): void {
		this.transientEffects.push(new Explosion(x, y, radius));
	}

	/** Spawn a sinking effect for a destroyed vehicle. */
	spawnSinking(
		x: number,
		y: number,
		heading: number,
		size: number,
		color: number,
	): void {
		this.transientEffects.push(new Sinking(x, y, heading, size, color));
	}

	/**
	 * Update all effects. Call once per frame with interpolated entities.
	 * Manages wake trails and stern churns based on entity state,
	 * detects deaths to spawn sinking effects, and advances transient effects.
	 */
	update(entities: EntityState[], dt: number): void {
		const activeIds = new Set<number>();

		for (const e of entities) {
			const defaults = VEHICLE_DEFAULTS[e.vehicleType];
			if (!defaults) continue;

			activeIds.add(e.id);

			// Detect death: hp was positive, now zero or negative
			const prevHp = this.previousHp.get(e.id) ?? e.hp;
			if (prevHp > 0 && e.hp <= 0) {
				const color = FACTION_COLORS[e.faction] ?? 0xcccccc;
				this.spawnSinking(e.x, e.y, e.heading, defaults.size, color);
				// Clear wake/churn so respawn at new position doesn't draw a line artifact
				this.wakeTrails.delete(e.id);
				this.sternChurns.delete(e.id);
			}
			this.previousHp.set(e.id, e.hp);

			// Skip dead or airborne vehicles for water effects
			if (e.hp <= 0 || defaults.airborne || e.vehicleType === "truck") continue;

			// Wake trail
			let wake = this.wakeTrails.get(e.id);
			if (!wake) {
				wake = new WakeTrail(e.id);
				this.wakeTrails.set(e.id, wake);
			}
			wake.feed(e.x, e.y, e.heading, e.speed, defaults.size, dt);

			// Stern churn
			let churn = this.sternChurns.get(e.id);
			if (!churn) {
				churn = new SternChurn(e.id);
				this.sternChurns.set(e.id, churn);
			}
			churn.feed(
				e.x,
				e.y,
				e.heading,
				e.speed,
				defaults.maxSpeed,
				defaults.size,
				dt,
			);
		}

		// Remove effects for entities that no longer exist
		for (const [id] of this.wakeTrails) {
			if (!activeIds.has(id)) this.wakeTrails.delete(id);
		}
		for (const [id] of this.sternChurns) {
			if (!activeIds.has(id)) this.sternChurns.delete(id);
		}
		for (const [id] of this.previousHp) {
			if (!activeIds.has(id)) this.previousHp.delete(id);
		}

		// Update transient effects
		for (const e of this.transientEffects) {
			e.update(dt);
		}
		this.transientEffects = this.transientEffects.filter((e) => e.alive);
	}

	/** Draw all effects. Call after update(), before vehicle rendering. */
	draw(cam: Camera): void {
		this.graphics.clear();

		// Wake trails (behind everything)
		for (const [, wake] of this.wakeTrails) {
			wake.draw(this.graphics, cam);
		}

		// Stern churns
		for (const [, churn] of this.sternChurns) {
			churn.draw(this.graphics, cam);
		}

		// Transient effects (explosions, sinking)
		for (const e of this.transientEffects) {
			e.draw(this.graphics, cam);
		}
	}
}
