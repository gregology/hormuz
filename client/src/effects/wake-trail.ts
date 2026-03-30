/**
 * Wake trail effect — a fading path of foam behind moving water vehicles.
 *
 * Stores a ring buffer of recent stern positions. Each frame, if the
 * vehicle is moving, a new point is added. Points fade and widen over
 * their lifetime, creating a V-shaped wake that dissolves behind the ship.
 */

import type { Graphics } from "pixi.js";
import type { Camera } from "../render/camera";
import { worldToScreen } from "../render/camera";
import type { Effect } from "./types";

interface WakePoint {
	x: number;
	y: number;
	age: number;
	speed: number;
	heading: number;
}

const MAX_AGE = 20.0; // seconds before a wake point disappears
const EMIT_INTERVAL = 0.05; // seconds between new points (~20/sec)

export class WakeTrail implements Effect {
	alive = true;
	private points: WakePoint[] = [];
	private timeSinceEmit = 0;
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
		size: number,
		dt: number,
	): void {
		// Age existing points
		for (const p of this.points) p.age += dt;
		this.points = this.points.filter((p) => p.age < MAX_AGE);

		this.timeSinceEmit += dt;
		if (Math.abs(speed) < 0.3 || this.timeSinceEmit < EMIT_INTERVAL) return;

		this.timeSinceEmit = 0;

		// Emit at stern position
		const cos = Math.cos(heading);
		const sin = Math.sin(heading);
		const sternX = x - cos * size * 0.45;
		const sternY = y - sin * size * 0.45;

		this.points.push({
			x: sternX,
			y: sternY,
			age: 0,
			speed: Math.abs(speed),
			heading,
		});
	}

	update(_dt: number): void {
		// Aging is done in feed()
	}

	draw(g: Graphics, cam: Camera): void {
		if (this.points.length < 2) return;

		// Center foam line
		for (let i = 1; i < this.points.length; i++) {
			const p = this.points[i];
			const prev = this.points[i - 1];
			const life = 1 - p.age / MAX_AGE;
			// Bright near the stern, fading over distance
			const alpha = life * life * 0.2;
			if (alpha < 0.003) continue;

			const a = worldToScreen(cam, prev.x, prev.y);
			const b = worldToScreen(cam, p.x, p.y);

			g.moveTo(a.x, a.y);
			g.lineTo(b.x, b.y);
			g.stroke({ color: 0xffffff, width: 1.5 + life * 1.5, alpha });
		}

		// V-spread lines: widen gradually, Kelvin wake angle (~19.5 deg)
		for (let i = 1; i < this.points.length; i++) {
			const p = this.points[i];
			const prev = this.points[i - 1];
			const life = 1 - p.age / MAX_AGE;
			const alpha = life * life * 0.07;
			if (alpha < 0.002) continue;

			const cos = Math.cos(p.heading);
			const sin = Math.sin(p.heading);

			// Spread grows with age — real wakes widen at ~19.5 degrees
			// but also scale with speed (faster = wider absolute spread)
			const spread = p.age * p.speed * 0.12;

			const prevCos = Math.cos(prev.heading);
			const prevSin = Math.sin(prev.heading);
			const prevSpread = prev.age * prev.speed * 0.12;

			for (const side of [-1, 1]) {
				const sx = p.x + -sin * side * spread;
				const sy = p.y + cos * side * spread;
				const psx = prev.x + -prevSin * side * prevSpread;
				const psy = prev.y + prevCos * side * prevSpread;

				const a = worldToScreen(cam, psx, psy);
				const b = worldToScreen(cam, sx, sy);
				g.moveTo(a.x, a.y);
				g.lineTo(b.x, b.y);
				g.stroke({ color: 0xffffff, width: 0.8 + life, alpha });
			}
		}
	}
}
