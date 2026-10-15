/**
 * Stern churn — foamy turbulence thrown up by the propellers when a ship
 * is moving at speed, plus the bow wave peeling off either side of the
 * stem. Particles are simulated here and drawn into the shared spray batch.
 */

import { particleDiameterPixels } from "../render/particles";
import type { EffectParticles } from "./types";

interface ChurnParticle {
	x: number;
	y: number;
	age: number;
	maxAge: number;
	radius: number;
	vx: number;
	vy: number;
}

const EMIT_RATE = 18; // particles per second at full speed
const BOW_EMIT_RATE = 16;
const MAX_PARTICLES = 256;

// Height above water surface to avoid z-fighting
const WATER_Y = 0.12;

export class SternChurn {
	private particles: ChurnParticle[] = [];
	private emitAccum = 0;
	private bowAccum = 0;

	/** Call each frame with the vehicle's current state. */
	feed(
		x: number,
		y: number,
		heading: number,
		speed: number,
		equilibriumSpeed: number,
		size: number,
		dt: number,
	): void {
		for (const p of this.particles) {
			p.age += dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.radius += dt * size * 0.03;
		}
		this.particles = this.particles.filter((p) => p.age < p.maxAge);

		const intensity = Math.min(Math.abs(speed) / equilibriumSpeed, 1);
		if (intensity < 0.1) return;

		this.emitAccum += EMIT_RATE * intensity * dt;
		this.bowAccum += BOW_EMIT_RATE * intensity * dt;

		const cos = Math.cos(heading);
		const sin = Math.sin(heading);

		// Bow wave: thrown outwards from both sides of the stem.
		const bowX = x + cos * size * 0.44;
		const bowY = y + sin * size * 0.44;
		while (this.bowAccum >= 1 && this.particles.length < MAX_PARTICLES) {
			this.bowAccum -= 1;
			const side = Math.random() < 0.5 ? -1 : 1;
			const out = Math.abs(speed) * (0.2 + Math.random() * 0.15);
			this.particles.push({
				x: bowX - sin * side * size * 0.04,
				y: bowY + cos * side * size * 0.04,
				age: 0,
				maxAge: 0.6 + Math.random() * 0.5,
				radius: size * (0.01 + Math.random() * 0.012),
				vx: -sin * side * out - cos * Math.abs(speed) * 0.1,
				vy: cos * side * out - sin * Math.abs(speed) * 0.1,
			});
		}
		const sternX = x - cos * size * 0.45;
		const sternY = y - sin * size * 0.45;

		while (this.emitAccum >= 1 && this.particles.length < MAX_PARTICLES) {
			this.emitAccum -= 1;

			const spread = size * 0.08;
			const ox = (Math.random() - 0.5) * spread * -sin;
			const oy = (Math.random() - 0.5) * spread * cos;

			const pushSpeed = speed * 0.3;
			this.particles.push({
				x: sternX + ox,
				y: sternY + oy,
				age: 0,
				maxAge: 0.8 + Math.random() * 0.6,
				radius: size * 0.02 + Math.random() * size * 0.02,
				vx: -cos * pushSpeed + (Math.random() - 0.5) * 2,
				vy: -sin * pushSpeed + (Math.random() - 0.5) * 2,
			});
		}
	}

	draw(particles: EffectParticles, zoom: number): void {
		for (const p of this.particles) {
			const life = 1 - p.age / p.maxAge;
			const pixels = particleDiameterPixels(p.radius, zoom);
			if (pixels < 0.6) continue;
			particles.spray.push(
				p.x,
				WATER_Y,
				p.y,
				pixels,
				0.9,
				0.93,
				0.94,
				life * 0.45,
			);
		}
	}
}
