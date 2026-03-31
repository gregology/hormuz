/**
 * Stern churn effect (Three.js) — foamy turbulence at the stern when
 * a ship is moving at speed. Rendered as a THREE.Points particle system
 * with per-vertex alpha and screen-space circular point sprites.
 */

import * as THREE from "three";
import type { ThreeEffect } from "./types";

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
const MAX_PARTICLES = 256;
const SQRT6 = Math.sqrt(6);

// Height above water surface to avoid z-fighting
const WATER_Y = 0.1;

const POINT_VERT = `
in float aAlpha;
in float aSize;
out float vAlpha;
void main() {
    vAlpha = aAlpha;
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const POINT_FRAG = `
in float vAlpha;
out vec4 fragColor;
void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    fragColor = vec4(1.0, 1.0, 1.0, vAlpha);
}
`;

export class SternChurn implements ThreeEffect {
	alive = true;
	readonly root: THREE.Points;
	private particles: ChurnParticle[] = [];
	private emitAccum = 0;
	private entityId: number;
	private geometry: THREE.BufferGeometry;

	constructor(entityId: number) {
		this.entityId = entityId;

		const positions = new Float32Array(MAX_PARTICLES * 3);
		const alphas = new Float32Array(MAX_PARTICLES);
		const sizes = new Float32Array(MAX_PARTICLES);

		this.geometry = new THREE.BufferGeometry();
		this.geometry.setAttribute(
			"position",
			new THREE.BufferAttribute(positions, 3),
		);
		this.geometry.setAttribute(
			"aAlpha",
			new THREE.BufferAttribute(alphas, 1),
		);
		this.geometry.setAttribute(
			"aSize",
			new THREE.BufferAttribute(sizes, 1),
		);
		this.geometry.setDrawRange(0, 0);

		const material = new THREE.ShaderMaterial({
			vertexShader: POINT_VERT,
			fragmentShader: POINT_FRAG,
			transparent: true,
			depthWrite: false,
			glslVersion: THREE.GLSL3,
		});

		this.root = new THREE.Points(this.geometry, material);
		this.root.frustumCulled = false;
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
			p.radius += dt * 2;
		}
		this.particles = this.particles.filter((p) => p.age < p.maxAge);

		const intensity = Math.min(Math.abs(speed) / maxSpeed, 1);
		if (intensity < 0.1) return;

		this.emitAccum += EMIT_RATE * intensity * dt;

		const cos = Math.cos(heading);
		const sin = Math.sin(heading);
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
				maxAge: 0.6 + Math.random() * 0.4,
				radius: size * 0.02 + Math.random() * size * 0.02,
				vx: -cos * pushSpeed + (Math.random() - 0.5) * 2,
				vy: -sin * pushSpeed + (Math.random() - 0.5) * 2,
			});
		}
	}

	update(_dt: number, zoom: number): void {
		const posAttr = this.geometry.attributes.position as THREE.BufferAttribute;
		const alphaAttr = this.geometry.attributes.aAlpha as THREE.BufferAttribute;
		const sizeAttr = this.geometry.attributes.aSize as THREE.BufferAttribute;
		const positions = posAttr.array as Float32Array;
		const alphas = alphaAttr.array as Float32Array;
		const sizes = sizeAttr.array as Float32Array;

		const pixelScale = zoom * SQRT6;
		let count = 0;

		for (const p of this.particles) {
			if (count >= MAX_PARTICLES) break;
			const life = 1 - p.age / p.maxAge;
			const alpha = life * 0.25;
			if (alpha < 0.01) continue;
			const pixelR = p.radius * pixelScale;
			if (pixelR < 0.3) continue;

			const i3 = count * 3;
			positions[i3] = p.x;
			positions[i3 + 1] = WATER_Y;
			positions[i3 + 2] = p.y;
			alphas[count] = alpha;
			sizes[count] = pixelR * 2; // diameter in pixels
			count++;
		}

		this.geometry.setDrawRange(0, count);
		posAttr.needsUpdate = true;
		alphaAttr.needsUpdate = true;
		sizeAttr.needsUpdate = true;
	}

	dispose(): void {
		this.geometry.dispose();
		(this.root.material as THREE.Material).dispose();
	}
}
