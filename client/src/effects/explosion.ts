/**
 * Explosion effect — expanding fireball with shockwave ring and debris.
 *
 * Triggered by MSG_EVENT "explosion" from the server (shahed-tanker
 * collision). Draws an expanding bright core, a shockwave ring, and
 * fading smoke/debris particles.
 */

import type { Graphics } from "pixi.js";
import type { Camera } from "../render/camera";
import { worldToScreen } from "../render/camera";
import type { Effect } from "./types";

interface Debris {
	x: number;
	y: number;
	vx: number;
	vy: number;
	radius: number;
	color: number;
}

const DURATION = 1.5; // total lifetime in seconds
const CORE_DURATION = 0.3; // bright core phase

export class Explosion implements Effect {
	alive = true;
	private age = 0;
	private x: number;
	private y: number;
	private maxRadius: number;
	private debris: Debris[] = [];

	constructor(x: number, y: number, radius = 60) {
		this.x = x;
		this.y = y;
		this.maxRadius = radius;

		// Spawn debris particles
		const count = 12 + Math.floor(Math.random() * 8);
		for (let i = 0; i < count; i++) {
			const angle = Math.random() * Math.PI * 2;
			const speed = 20 + Math.random() * 80;
			this.debris.push({
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				radius: 1 + Math.random() * 3,
				color:
					Math.random() > 0.5
						? 0xff6600 // fire orange
						: Math.random() > 0.5
							? 0xff3300 // deep red
							: 0x444444, // dark smoke
			});
		}
	}

	update(dt: number): void {
		this.age += dt;
		if (this.age >= DURATION) {
			this.alive = false;
			return;
		}

		// Move debris (decelerate over time)
		const drag = 0.95;
		for (const d of this.debris) {
			d.x += d.vx * dt;
			d.y += d.vy * dt;
			d.vx *= drag;
			d.vy *= drag;
		}
	}

	draw(g: Graphics, cam: Camera): void {
		const t = this.age / DURATION; // 0 to 1
		const center = worldToScreen(cam, this.x, this.y);

		// Core flash (bright yellow-white, shrinks after initial burst)
		if (this.age < CORE_DURATION) {
			const coreT = this.age / CORE_DURATION;
			const coreR = this.maxRadius * (0.3 + coreT * 0.4) * cam.zoom;
			const coreAlpha = 1 - coreT * 0.7;
			g.circle(center.x, center.y, coreR);
			g.fill({ color: 0xffcc00, alpha: coreAlpha });

			// Inner white hot core
			g.circle(center.x, center.y, coreR * 0.4);
			g.fill({ color: 0xffffff, alpha: coreAlpha * 0.8 });
		}

		// Shockwave ring (expands outward, fades)
		const ringR = this.maxRadius * t * 1.5 * cam.zoom;
		const ringAlpha = (1 - t) * 0.4;
		if (ringAlpha > 0.01 && ringR > 1) {
			g.circle(center.x, center.y, ringR);
			g.stroke({ color: 0xff8800, width: 2 + (1 - t) * 3, alpha: ringAlpha });
		}

		// Smoke cloud (expands slowly, persists longer)
		if (this.age > 0.1) {
			const smokeR = this.maxRadius * (0.2 + t * 0.6) * cam.zoom;
			const smokeAlpha = (1 - t) * 0.15;
			if (smokeAlpha > 0.005) {
				g.circle(center.x, center.y, smokeR);
				g.fill({ color: 0x333333, alpha: smokeAlpha });
			}
		}

		// Debris particles
		for (const d of this.debris) {
			const alpha = (1 - t) * 0.6;
			if (alpha < 0.01) continue;
			const s = worldToScreen(cam, d.x, d.y);
			const r = d.radius * cam.zoom;
			if (r < 0.3) continue;
			g.circle(s.x, s.y, r);
			g.fill({ color: d.color, alpha });
		}
	}
}
