/**
 * Three.js effect manager — lifecycle management for all visual effects.
 *
 * Owns a THREE.Group added to the scene graph. Handles:
 *   - WakeSystem: global ring buffer for all ship wake trails (1 draw call)
 *   - Continuous per-entity emitters: stern churn, damage smoke
 *   - Transient effects (explosions, sinking, oil patches) that run independently
 *   - Shared particle batches (spray, smoke, glow) every effect draws into
 */

import * as THREE from "three/webgpu";
import type { EntityState } from "../game/entities";
import { MAX_HP, VEHICLE_PHYSICS } from "../generated/vehicles";
import { ParticleBatch } from "../render/particles";
import { terrainSurfaceHeight } from "../render/terrain-surface";
import type { VehicleType } from "../vehicles/physics";
import { DamageSmoke, SMOKE_BELOW_HEALTH } from "./damage-smoke";
import { Explosion } from "./explosion";
import { OilPatch, oilPatchParams } from "./oil-patch";
import { Sinking } from "./sinking";
import { SternChurn } from "./stern-churn";
import type { EffectParticles, ThreeEffect } from "./types";
import { WakeSystem } from "./wake-system";

/** Deck height above the vehicle's base, as a fraction of size (where smoke rises from). */
const SMOKE_SOURCE_HEIGHT = 0.12;

export class ThreeEffectManager {
	readonly root: THREE.Group;
	private transientEffects: ThreeEffect[] = [];
	private wakeSystem: WakeSystem;
	private sternChurns = new Map<number, SternChurn>();
	private damageSmoke = new Map<number, DamageSmoke>();
	private previousHp = new Map<number, number>();
	private particles: EffectParticles;
	private time = 0;

	constructor() {
		this.root = new THREE.Group();
		this.wakeSystem = new WakeSystem();
		this.particles = {
			spray: new ParticleBatch(8192, {
				shape: "soft",
				daylit: true,
				renderOrder: 3,
			}),
			smoke: new ParticleBatch(8192, {
				shape: "soft",
				daylit: true,
				renderOrder: 8,
			}),
			glow: new ParticleBatch(4096, {
				shape: "glow",
				additive: true,
				renderOrder: 9,
			}),
		};
		this.root.add(
			this.wakeSystem.root,
			this.particles.spray.object,
			this.particles.smoke.object,
			this.particles.glow.object,
		);
	}

	/** Spawn an explosion effect at the given world position. */
	spawnExplosion(x: number, y: number, radius = 60): void {
		this.addTransient(new Explosion(x, y, radius));
	}

	/** Spawn the sinking wreck of a destroyed vehicle. */
	spawnSinking(entity: EntityState): void {
		this.addTransient(
			new Sinking(
				entity.x,
				entity.y,
				entity.heading,
				entity.vehicleType as VehicleType,
				entity.id,
				entity.floodLevel ?? 0,
				entity.listAngle ?? 0,
			),
		);
	}

	/** Spawn an oil patch at the given position, sized for the vehicle type. */
	spawnOilPatch(x: number, y: number, vehicleType: string, size: number): void {
		const { radius, duration } = oilPatchParams(vehicleType, size);
		this.addTransient(new OilPatch(x, y, radius, duration));
	}

	/**
	 * Update all effects. Call once per frame with interpolated entities.
	 * Zoom is needed for screen-pixel-to-world-unit conversions.
	 */
	update(entities: EntityState[], dt: number, zoom: number): void {
		this.time += dt;
		const activeIds = new Set<number>();
		const fedSmoke = new Set<number>();

		for (const e of entities) {
			const physics = VEHICLE_PHYSICS[e.vehicleType as VehicleType];
			if (!physics) continue;

			activeIds.add(e.id);
			const onWater = !physics.airborne && e.vehicleType !== "truck";

			// Detect death: hp was positive, now zero or negative
			const prevHp = this.previousHp.get(e.id) ?? e.hp;
			if (prevHp > 0 && e.hp <= 0) {
				this.spawnSinking(e);
				if (onWater) this.spawnOilPatch(e.x, e.y, e.vehicleType, physics.size);

				// Detach wake (existing points remain and fade naturally)
				this.wakeSystem.detach(e.id);
				this.sternChurns.delete(e.id);
			}
			this.previousHp.set(e.id, e.hp);

			if (e.hp <= 0) continue;

			// Burning damage (ships and trucks; drones die outright)
			const maxHp = MAX_HP[e.vehicleType as VehicleType] ?? 100;
			const health = e.hp / maxHp;
			const flooding = e.floodLevel ?? 0;
			const damage = Math.max(
				(SMOKE_BELOW_HEALTH - health) / SMOKE_BELOW_HEALTH,
				flooding > 0.05 ? 0.3 + flooding * 0.7 : 0,
			);
			let smoke = this.damageSmoke.get(e.id);
			if (damage > 0 && !physics.airborne) {
				if (!smoke) {
					smoke = new DamageSmoke();
					this.damageSmoke.set(e.id, smoke);
				}
				fedSmoke.add(e.id);
				const base = onWater ? 0 : terrainSurfaceHeight(e.x, e.y);
				smoke.feed(
					e.x,
					e.y,
					e.heading,
					physics.size,
					base + physics.size * SMOKE_SOURCE_HEIGHT,
					Math.min(damage, 1),
					dt,
				);
			}

			if (!onWater) continue;

			// Feed wake system (global ring buffer)
			this.wakeSystem.emit(
				e.id,
				e.x,
				e.y,
				e.heading,
				e.speed,
				physics.size,
				physics.maxSpeed,
				dt,
			);

			let churn = this.sternChurns.get(e.id);
			if (!churn) {
				churn = new SternChurn();
				this.sternChurns.set(e.id, churn);
			}
			churn.feed(
				e.x,
				e.y,
				e.heading,
				e.speed,
				physics.maxSpeed,
				physics.size,
				dt,
			);
		}

		// Forget emitters for entities that no longer exist (smoke drifts away first)
		for (const [id] of this.sternChurns) {
			if (!activeIds.has(id)) this.sternChurns.delete(id);
		}
		for (const [id, smoke] of this.damageSmoke) {
			if (fedSmoke.has(id)) continue;
			smoke.extinguish();
			smoke.advance(dt);
			if (smoke.idle) this.damageSmoke.delete(id);
		}
		for (const [id] of this.previousHp) {
			if (!activeIds.has(id)) this.previousHp.delete(id);
		}

		// Detach wakes for entities that left (points remain and fade)
		this.wakeSystem.detachMissing(activeIds);
		this.wakeSystem.update(dt, zoom);

		for (const effect of this.transientEffects) {
			effect.update(dt, zoom);
		}
		const dead = this.transientEffects.filter((e) => !e.alive);
		for (const effect of dead) {
			this.root.remove(effect.root);
			effect.dispose();
		}
		this.transientEffects = this.transientEffects.filter((e) => e.alive);

		this.drawParticles(zoom);
	}

	private drawParticles(zoom: number): void {
		const { spray, smoke, glow } = this.particles;
		for (const batch of [spray, smoke, glow]) batch.clear();
		for (const [, churn] of this.sternChurns) churn.draw(this.particles, zoom);
		for (const [, emitter] of this.damageSmoke)
			emitter.draw(this.particles, zoom, this.time);
		for (const effect of this.transientEffects)
			effect.drawParticles?.(this.particles, zoom);
		for (const batch of [spray, smoke, glow]) batch.commit();
	}

	private addTransient(effect: ThreeEffect): void {
		this.transientEffects.push(effect);
		this.root.add(effect.root);
	}

	/** Clean up all GPU resources. */
	dispose(): void {
		this.wakeSystem.dispose();
		for (const effect of this.transientEffects) {
			this.root.remove(effect.root);
			effect.dispose();
		}
		for (const batch of Object.values(this.particles)) batch.dispose();
		this.root.clear();
		this.sternChurns.clear();
		this.damageSmoke.clear();
		this.transientEffects = [];
	}
}
