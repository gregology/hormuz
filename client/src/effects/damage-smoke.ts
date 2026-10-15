/**
 * Damage smoke — a burning, damaged vehicle trails a column of smoke that
 * thickens as it takes damage, with flames licking at the base when it is
 * badly hit. Simulated here, drawn into the shared particle batches.
 */

import { particleDiameterPixels } from "../render/particles";
import { type EffectParticles, WIND } from "./types";

interface Puff {
	x: number;
	y: number;
	z: number;
	radius: number;
	age: number;
	life: number;
	rise: number;
}

/** Below this fraction of max HP a vehicle starts to smoke. */
export const SMOKE_BELOW_HEALTH = 0.75;
/** Above this damage level (≈ below 40% health) it is visibly on fire. */
const FIRE_ABOVE_DAMAGE = 0.45;
const MAX_PUFFS = 160;

export class DamageSmoke {
	private readonly puffs: Puff[] = [];
	private emitAccum = 0;
	private fire = 0;
	private source = { x: 0, y: 0, z: 0, size: 1 };

	/**
	 * Advance and emit. `damage` is 0 (healthy) .. 1 (wrecked); `deckHeight`
	 * is the world height smoke rises from.
	 */
	feed(
		x: number,
		y: number,
		heading: number,
		size: number,
		deckHeight: number,
		damage: number,
		dt: number,
	): void {
		this.advance(dt);

		// Smoke comes from the damaged area amidships/aft, not the bow.
		const sourceX = x - Math.cos(heading) * size * 0.1;
		const sourceZ = y - Math.sin(heading) * size * 0.1;
		this.source = { x: sourceX, y: deckHeight, z: sourceZ, size };
		this.fire = Math.max(
			0,
			(damage - FIRE_ABOVE_DAMAGE) / (1 - FIRE_ABOVE_DAMAGE),
		);

		this.emitAccum += damage * 9 * dt;
		while (this.emitAccum >= 1 && this.puffs.length < MAX_PUFFS) {
			this.emitAccum -= 1;
			this.puffs.push({
				x: sourceX + (Math.random() - 0.5) * size * 0.08,
				y: deckHeight,
				z: sourceZ + (Math.random() - 0.5) * size * 0.08,
				radius: size * (0.025 + Math.random() * 0.03) * (0.6 + damage * 0.6),
				age: 0,
				life: 4 + Math.random() * 4,
				rise: size * (0.08 + Math.random() * 0.06),
			});
		}
	}

	/** Age and drift existing smoke without emitting (vehicle gone or repaired). */
	advance(dt: number): void {
		for (const p of this.puffs) {
			p.age += dt;
			p.y += p.rise * dt;
			p.x += WIND.x * dt * 1.5;
			p.z += WIND.z * dt * 1.5;
			p.radius += this.source.size * 0.035 * dt;
			p.rise *= 0.995;
		}
		for (let i = this.puffs.length - 1; i >= 0; i--) {
			if (this.puffs[i].age >= this.puffs[i].life) this.puffs.splice(i, 1);
		}
	}

	/** Stop the flames (the smoke already in the air keeps drifting). */
	extinguish(): void {
		this.fire = 0;
	}

	get idle(): boolean {
		return this.puffs.length === 0;
	}

	draw(particles: EffectParticles, zoom: number, time: number): void {
		for (const p of this.puffs) {
			const life = p.age / p.life;
			const shade = 0.04 + life * 0.12;
			particles.smoke.push(
				p.x,
				p.y,
				p.z,
				particleDiameterPixels(p.radius, zoom),
				shade,
				shade * 0.96,
				shade * 0.92,
				Math.min(1, p.age * 3) * (1 - life) * 0.5,
			);
		}
		if (this.fire > 0) {
			const { x, y, z, size } = this.source;
			for (let i = 0; i < 3; i++) {
				const flicker = 0.7 + 0.3 * Math.sin(time * (13 + i * 5) + i * 2);
				particles.glow.push(
					x + (i - 1) * size * 0.03,
					y + size * 0.015 * (i + 1),
					z,
					particleDiameterPixels(size * 0.03 * flicker, zoom),
					5 * flicker,
					1.5 * flicker,
					0.25,
					this.fire * flicker,
				);
			}
		}
	}
}
