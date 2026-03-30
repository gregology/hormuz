/**
 * Sinking effect — a destroyed ship tilts and sinks below the waterline.
 *
 * Captures the vehicle's last known position, heading, and appearance.
 * Over its lifetime: the vehicle tilts (bow rises), sinks (y-offset
 * increases), fades in opacity, and emits bubbles.
 */

import type { Graphics } from "pixi.js";
import type { Camera } from "../render/camera";
import { worldToScreen } from "../render/camera";
import type { Effect } from "./types";

interface Bubble {
	x: number;
	y: number;
	vy: number;
	radius: number;
	age: number;
}

const DURATION = 3.0; // total sinking time

export class Sinking implements Effect {
	alive = true;
	private age = 0;
	private x: number;
	private y: number;
	private heading: number;
	private size: number;
	private color: number;
	private bubbles: Bubble[] = [];
	private bubbleAccum = 0;

	constructor(
		x: number,
		y: number,
		heading: number,
		size: number,
		color: number,
	) {
		this.x = x;
		this.y = y;
		this.heading = heading;
		this.size = size;
		this.color = color;
	}

	update(dt: number): void {
		this.age += dt;
		if (this.age >= DURATION) {
			this.alive = false;
			return;
		}

		const t = this.age / DURATION;

		// Slowly drift and rotate
		this.heading += dt * 0.1;
		this.x += Math.cos(this.heading) * dt * 0.5;
		this.y += Math.sin(this.heading) * dt * 0.5;

		// Emit bubbles (more at start, fewer later)
		const bubbleRate = (1 - t) * 8;
		this.bubbleAccum += bubbleRate * dt;
		while (this.bubbleAccum >= 1) {
			this.bubbleAccum -= 1;
			const cos = Math.cos(this.heading);
			const sin = Math.sin(this.heading);
			const ox = (Math.random() - 0.5) * this.size * 0.4;
			const oy = (Math.random() - 0.5) * this.size * 0.2;
			this.bubbles.push({
				x: this.x + cos * ox - sin * oy,
				y: this.y + sin * ox + cos * oy,
				vy: -(1 + Math.random() * 2), // float upward (screen space)
				radius: 1 + Math.random() * 2,
				age: 0,
			});
		}

		// Update bubbles
		for (const b of this.bubbles) {
			b.age += dt;
			b.x += (Math.random() - 0.5) * dt * 3;
		}
		this.bubbles = this.bubbles.filter((b) => b.age < 1.5);
	}

	draw(g: Graphics, cam: Camera): void {
		const t = this.age / DURATION;
		const alpha = (1 - t) * 0.6;
		if (alpha < 0.01) return;

		// Sinking offset (increases over time — ship goes "underwater")
		const sinkOffset = t * this.size * 0.3;

		const cos = Math.cos(this.heading);
		const sin = Math.sin(this.heading);
		const halfLen = this.size * 0.4;
		const halfBeam = this.size * 0.08;

		// Draw a simplified hull outline that tilts and sinks
		// Bow (front) rises slightly, stern sinks
		const bowRise = t * this.size * 0.1; // bow lifts

		const points: { x: number; y: number }[] = [];
		const outline: [number, number][] = [
			[halfLen, 0], // bow
			[halfLen * 0.7, -halfBeam],
			[-halfLen * 0.5, -halfBeam],
			[-halfLen, -halfBeam * 0.5],
			[-halfLen, halfBeam * 0.5],
			[-halfLen * 0.5, halfBeam],
			[halfLen * 0.7, halfBeam],
		];

		for (const [lx, ly] of outline) {
			const wx = this.x + (lx * cos - ly * sin);
			const wy = this.y + (lx * sin + ly * cos);
			const s = worldToScreen(cam, wx, wy);
			// Apply sinking + bow rise (bow = positive lx rises, stern = negative lx sinks)
			const heightOffset = sinkOffset - (lx / halfLen) * bowRise;
			s.y += heightOffset * cam.zoom;
			points.push(s);
		}

		if (points.length > 2) {
			g.moveTo(points[0].x, points[0].y);
			for (let i = 1; i < points.length; i++) {
				g.lineTo(points[i].x, points[i].y);
			}
			g.closePath();
			g.fill({ color: this.color, alpha: alpha * 0.5 });
			g.stroke({ color: 0x000000, width: 1, alpha: alpha * 0.3 });
		}

		// Bubbles
		for (const b of this.bubbles) {
			const bubbleAlpha = (1 - b.age / 1.5) * 0.3 * (1 - t);
			if (bubbleAlpha < 0.01) continue;
			const s = worldToScreen(cam, b.x, b.y);
			s.y += b.vy * b.age * cam.zoom * 5;
			const r = b.radius * cam.zoom;
			if (r < 0.3) continue;
			g.circle(s.x, s.y, r);
			g.fill({ color: 0xaaddff, alpha: bubbleAlpha });
		}
	}
}
