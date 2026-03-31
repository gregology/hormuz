/**
 * Wake trail effect (Three.js) — fading ribbon of foam behind moving
 * water vehicles.
 *
 * Stores a buffer of recent stern positions. Each frame, the positions
 * are rebuilt into a triangle-strip ribbon mesh with per-vertex alpha.
 * Three ribbons: center foam line + left/right V-spread (Kelvin wake).
 */

import * as THREE from "three";
import type { ThreeEffect } from "./types";

interface WakePoint {
	x: number;
	y: number;
	age: number;
	speed: number;
	heading: number;
}

const MAX_AGE = 20.0;
const EMIT_INTERVAL = 0.05;
const SQRT6 = Math.sqrt(6);

// Height just above water to avoid z-fighting
const WATER_Y = 0.05;

// Maximum wake points (~20 per second * 20 seconds)
const MAX_POINTS = 420;
// 3 ribbons (center, left, right), each segment = 6 vertices (2 triangles)
const MAX_VERTICES = 3 * (MAX_POINTS - 1) * 6;

const RIBBON_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
in float aAlpha;
out float vAlpha;
void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}
`;

const RIBBON_FRAG = `
#include <logdepthbuf_pars_fragment>
in float vAlpha;
out vec4 fragColor;
void main() {
    if (vAlpha < 0.002) discard;
    fragColor = vec4(1.0, 1.0, 1.0, vAlpha);
    #include <logdepthbuf_fragment>
}
`;

export class WakeTrail implements ThreeEffect {
	alive = true;
	readonly root: THREE.Mesh;
	private points: WakePoint[] = [];
	private timeSinceEmit = 0;
	private entityId: number;
	private geometry: THREE.BufferGeometry;

	constructor(entityId: number) {
		this.entityId = entityId;

		const positions = new Float32Array(MAX_VERTICES * 3);
		const alphas = new Float32Array(MAX_VERTICES);

		this.geometry = new THREE.BufferGeometry();
		this.geometry.setAttribute(
			"position",
			new THREE.BufferAttribute(positions, 3),
		);
		this.geometry.setAttribute(
			"aAlpha",
			new THREE.BufferAttribute(alphas, 1),
		);
		this.geometry.setDrawRange(0, 0);

		const material = new THREE.ShaderMaterial({
			vertexShader: RIBBON_VERT,
			fragmentShader: RIBBON_FRAG,
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			glslVersion: THREE.GLSL3,
		});

		this.root = new THREE.Mesh(this.geometry, material);
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
		size: number,
		dt: number,
	): void {
		for (const p of this.points) p.age += dt;
		this.points = this.points.filter((p) => p.age < MAX_AGE);

		this.timeSinceEmit += dt;
		if (Math.abs(speed) < 0.3 || this.timeSinceEmit < EMIT_INTERVAL) return;

		this.timeSinceEmit = 0;

		const cos = Math.cos(heading);
		const sin = Math.sin(heading);
		const sternX = x - cos * size * 0.45;
		const sternY = y - sin * size * 0.45;

		this.points.push({ x: sternX, y: sternY, age: 0, speed: Math.abs(speed), heading });
	}

	update(_dt: number, zoom: number): void {
		const posAttr = this.geometry.attributes.position as THREE.BufferAttribute;
		const alphaAttr = this.geometry.attributes.aAlpha as THREE.BufferAttribute;
		const positions = posAttr.array as Float32Array;
		const alphas = alphaAttr.array as Float32Array;

		// World units per screen pixel
		const pixelsToWorld = 2 / (zoom * SQRT6);
		let vi = 0;

		if (this.points.length >= 2) {
			// Center foam ribbon
			vi = this.buildRibbon(
				positions,
				alphas,
				vi,
				pixelsToWorld,
				0, // no lateral offset
				(life) => (0.75 + life * 0.75) * pixelsToWorld, // half-width from pixel width 1.5+life*1.5
				(life) => life * life * 0.2,
				0.003,
			);

			// Left V-spread ribbon
			vi = this.buildRibbon(
				positions,
				alphas,
				vi,
				pixelsToWorld,
				-1,
				(life) => (0.4 + life * 0.5) * pixelsToWorld,
				(life) => life * life * 0.07,
				0.002,
			);

			// Right V-spread ribbon
			vi = this.buildRibbon(
				positions,
				alphas,
				vi,
				pixelsToWorld,
				1,
				(life) => (0.4 + life * 0.5) * pixelsToWorld,
				(life) => life * life * 0.07,
				0.002,
			);
		}

		this.geometry.setDrawRange(0, vi);
		posAttr.needsUpdate = true;
		alphaAttr.needsUpdate = true;
	}

	/**
	 * Build one ribbon into the shared buffers.
	 * @param side 0 = center, -1 = left spread, 1 = right spread
	 * @param halfWidthFn returns half-width in world units given life (0..1)
	 * @param alphaFn returns alpha given life (0..1)
	 * @param alphaThreshold minimum alpha to emit a segment
	 * @returns next vertex index
	 */
	private buildRibbon(
		positions: Float32Array,
		alphas: Float32Array,
		vi: number,
		_pixelsToWorld: number,
		side: number,
		halfWidthFn: (life: number) => number,
		alphaFn: (life: number) => number,
		alphaThreshold: number,
	): number {
		const pts = this.points;

		for (let i = 1; i < pts.length; i++) {
			const p = pts[i];
			const prev = pts[i - 1];

			const life = 1 - p.age / MAX_AGE;
			const prevLife = 1 - prev.age / MAX_AGE;
			const alpha = alphaFn(life);
			const prevAlpha = alphaFn(prevLife);
			if (alpha < alphaThreshold && prevAlpha < alphaThreshold) continue;

			// Current point position (with V-spread offset if side != 0)
			let cx = p.x;
			let cz = p.y;
			let px = prev.x;
			let pz = prev.y;

			if (side !== 0) {
				const spread = p.age * p.speed * 0.12;
				const prevSpread = prev.age * prev.speed * 0.12;
				const cos = Math.cos(p.heading);
				const sin = Math.sin(p.heading);
				const prevCos = Math.cos(prev.heading);
				const prevSin = Math.sin(prev.heading);
				cx += -sin * side * spread;
				cz += cos * side * spread;
				px += -prevSin * side * prevSpread;
				pz += prevCos * side * prevSpread;
			}

			// Direction from prev to current
			let dx = cx - px;
			let dz = cz - pz;
			const len = Math.sqrt(dx * dx + dz * dz);
			if (len < 0.001) continue;
			dx /= len;
			dz /= len;

			// Perpendicular in XZ plane (rotated 90° CCW)
			const nx = -dz;
			const nz = dx;

			const hw = halfWidthFn(life);
			const prevHw = halfWidthFn(prevLife);

			// Quad: prev-left, prev-right, curr-left, curr-right
			// Triangle 1: prev-left, prev-right, curr-left
			// Triangle 2: prev-right, curr-left, curr-right
			const base = vi * 3;

			// Triangle 1
			positions[base] = px + nx * prevHw;
			positions[base + 1] = WATER_Y;
			positions[base + 2] = pz + nz * prevHw;
			alphas[vi] = prevAlpha;
			vi++;

			positions[base + 3] = px - nx * prevHw;
			positions[base + 4] = WATER_Y;
			positions[base + 5] = pz - nz * prevHw;
			alphas[vi] = prevAlpha;
			vi++;

			positions[base + 6] = cx + nx * hw;
			positions[base + 7] = WATER_Y;
			positions[base + 8] = cz + nz * hw;
			alphas[vi] = alpha;
			vi++;

			// Triangle 2
			const base2 = vi * 3;
			positions[base2] = px - nx * prevHw;
			positions[base2 + 1] = WATER_Y;
			positions[base2 + 2] = pz - nz * prevHw;
			alphas[vi] = prevAlpha;
			vi++;

			positions[base2 + 3] = cx + nx * hw;
			positions[base2 + 4] = WATER_Y;
			positions[base2 + 5] = cz + nz * hw;
			alphas[vi] = alpha;
			vi++;

			positions[base2 + 6] = cx - nx * hw;
			positions[base2 + 7] = WATER_Y;
			positions[base2 + 8] = cz - nz * hw;
			alphas[vi] = alpha;
			vi++;
		}

		return vi;
	}

	dispose(): void {
		this.geometry.dispose();
		(this.root.material as THREE.Material).dispose();
	}
}
