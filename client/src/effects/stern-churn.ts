/**
 * Stern churn effect — foamy turbulence at the stern when a ship is
 * accelerating or moving at speed. Drawn as expanding, fading circles
 * clustered behind the vehicle.
 */

import type { Graphics } from "pixi.js";
import type { Camera } from "../render/camera";
import { worldToScreen } from "../render/camera";
import type { Effect } from "./types";

interface ChurnParticle {
	x: number;
	y: number;
	age: number;
	maxAge: number;
	radius: number;
	vx: number;
	vy: number;
}

const EMIT_RATE = 15; // particles per second at full speed

export class SternChurn implements Effect {
	alive = true;
	private particles: ChurnParticle[] = [];
	private emitAccum = 0;
	private entityId: number;

	constructor(entityId: number) {
		this.entityId = entityId;
	}

	getEntityId(): number {
		return this.entityId;
	}

	/** Call each frame with the vehicle's current state. */
	feed(
		x: number,
		y: number,
		heading: number,
		speed: number,
		maxSpeed: number,
		size: number,
		dt: number,
	): void {
		// Update existing particles
		for (const p of this.particles) {
			p.age += dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.radius += dt * 2; // expand
		}
		this.particles = this.particles.filter((p) => p.age < p.maxAge);

		const intensity = Math.min(Math.abs(speed) / maxSpeed, 1);
		if (intensity < 0.1) return;

		this.emitAccum += EMIT_RATE * intensity * dt;

		const cos = Math.cos(heading);
		const sin = Math.sin(heading);
		const sternX = x - cos * size * 0.45;
		const sternY = y - sin * size * 0.45;

		while (this.emitAccum >= 1) {
			this.emitAccum -= 1;

			// Random offset at stern
			const spread = size * 0.08;
			const ox = (Math.random() - 0.5) * spread * -sin;
			const oy = (Math.random() - 0.5) * spread * cos;

			// Velocity: pushed backward + slight random spread
			const pushSpeed = speed * 0.3;
			this.particles.push({
				x: sternX + ox,
				y: sternY + oy,
				age: 0,
				maxAge: 0.6 + Math.random() * 0.4,
				radius: size * 0.02 + Math.random() * size * 0.02,
				vx: -cos * pushSpeed + (Math.random() - 0.5) * 2,
				vy: -sin * pushSpeed + (Math.random() - 0.5) * 2,
			});
		}
	}

	update(_dt: number): void {
		// Particle update is done in feed()
	}

	draw(g: Graphics, cam: Camera): void {
		for (const p of this.particles) {
			const life = 1 - p.age / p.maxAge;
			const alpha = life * 0.25;
			if (alpha < 0.01) continue;

			const s = worldToScreen(cam, p.x, p.y);
			const r = p.radius * cam.zoom;
			if (r < 0.3) continue;

			g.circle(s.x, s.y, r);
			g.fill({ color: 0xffffff, alpha });
		}
	}
}
