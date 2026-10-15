/**
 * Global wake system — single-draw-call ring buffer for all ship wake trails.
 *
 * All entities write wake points into a shared ring buffer. Points are
 * completely independent of the entity that created them — when an entity
 * dies or leaves, its points remain and fade naturally. This eliminates
 * the "magic disappearing wake" artifact and scales to hundreds of ships
 * with a single GPU draw call.
 *
 * Each point stores a `prevIdx` linking it to the previous point in the
 * same entity's trail, forming chains that become ribbon segments during
 * the per-frame geometry rebuild. Three ribbons are built per segment:
 * center foam + left/right Kelvin V-spread.
 */

import {
	attribute,
	float,
	mx_noise_float,
	positionWorld,
	smoothstep,
	time,
	vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";

// --- Tuning constants ---

/** Maximum wake points in the ring buffer. Sized for ~120 water vehicles
 *  emitting at ~4 pts/sec for 120 seconds ≈ 57,600 points. */
const MAX_WAKE_POINTS = 65536;

/** How long a wake point lives before fading completely (seconds). */
const MAX_AGE = 120.0;

/** Minimum interval between point emissions per entity (seconds). */
const EMIT_INTERVAL = 0.25;

/** Height above water to avoid z-fighting with water surface. */
const WATER_Y = 0.08;

const SQRT6 = Math.sqrt(6);

/** Maximum distance between consecutive points before we break the chain
 *  (catches teleports and respawns). */
const MAX_SEGMENT_DIST = 500;

// 3 ribbons per segment, 6 vertices (2 triangles) per ribbon segment
const MAX_VERTICES = 3 * MAX_WAKE_POINTS * 6;

/** Kelvin wake: arms spread at tan(19.5°) of the distance travelled. */
const KELVIN_SPREAD = 0.35;
/** Kelvin arms vanish over the first (1 - ARM_FADE) of a wake point's life. */
const ARM_FADE = 0.75;

export class WakeSystem {
	readonly root: THREE.Mesh;

	// Ring buffer — struct-of-arrays for cache-friendly iteration
	private readonly px = new Float32Array(MAX_WAKE_POINTS);
	private readonly pz = new Float32Array(MAX_WAKE_POINTS);
	private readonly pHeading = new Float32Array(MAX_WAKE_POINTS);
	private readonly pSpeed = new Float32Array(MAX_WAKE_POINTS);
	private readonly pSize = new Float32Array(MAX_WAKE_POINTS);
	private readonly pBirth = new Float32Array(MAX_WAKE_POINTS);
	private readonly pPrev = new Int32Array(MAX_WAKE_POINTS).fill(-1);

	/** Next write position (monotonically increasing, mod MAX for slot). */
	private writeIdx = 0;
	/** Monotonic clock used as birth time for points. */
	private globalTime = 0;

	/** Per-entity: index of the last emitted point (for chaining). */
	private entityLastIdx = new Map<number, number>();
	/** Per-entity: time accumulator since last emission. */
	private entityEmitTimer = new Map<number, number>();

	private geometry: THREE.BufferGeometry;

	constructor() {
		const positions = new Float32Array(MAX_VERTICES * 3);
		const alphas = new Float32Array(MAX_VERTICES);

		this.geometry = new THREE.BufferGeometry();
		this.geometry.setAttribute(
			"position",
			new THREE.BufferAttribute(positions, 3),
		);
		this.geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
		// Which edge of its ribbon each vertex is on (fixed vertex order in buildSegment).
		const edges = new Float32Array(MAX_VERTICES);
		for (let i = 0; i < MAX_VERTICES; i++) edges[i] = i % 2 === 0 ? 1 : -1;
		this.geometry.setAttribute("aEdge", new THREE.BufferAttribute(edges, 1));
		this.geometry.setDrawRange(0, 0);

		// Lit foam, broken up by drifting noise so trails don't read as solid ribbons.
		const breakup = smoothstep(
			-0.35,
			0.45,
			mx_noise_float(vec3(positionWorld.xz.div(22), time.mul(0.15))),
		);
		const material = new THREE.MeshStandardNodeMaterial({
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
		});
		material.colorNode = vec3(0.86, 0.89, 0.9);
		material.roughnessNode = float(0.85);
		const edge = attribute<"float">("aEdge", "float");
		const feather = float(1).sub(edge.mul(edge));
		material.opacityNode = attribute<"float">("aAlpha", "float")
			.mul(breakup.mul(0.65).add(0.35))
			.mul(feather);

		this.root = new THREE.Mesh(this.geometry, material);
		this.root.frustumCulled = false;
	}

	/**
	 * Emit a wake point for the given entity. Call once per entity per frame.
	 * Points are only emitted when the entity is moving and the emission
	 * interval has elapsed.
	 */
	emit(
		entityId: number,
		x: number,
		y: number,
		heading: number,
		speed: number,
		size: number,
		dt: number,
	): void {
		const timer = (this.entityEmitTimer.get(entityId) ?? 0) + dt;
		this.entityEmitTimer.set(entityId, timer);

		if (Math.abs(speed) < 0.3 || timer < EMIT_INTERVAL) return;
		this.entityEmitTimer.set(entityId, 0);

		const cos = Math.cos(heading);
		const sin = Math.sin(heading);
		const sternX = x - cos * size * 0.45;
		const sternZ = y - sin * size * 0.45;

		const slot = this.writeIdx % MAX_WAKE_POINTS;

		this.px[slot] = sternX;
		this.pz[slot] = sternZ;
		this.pHeading[slot] = heading;
		this.pSpeed[slot] = Math.abs(speed);
		this.pSize[slot] = size;
		this.pBirth[slot] = this.globalTime;

		// Chain to previous point for this entity
		const prevSlot = this.entityLastIdx.get(entityId) ?? -1;
		if (prevSlot >= 0) {
			const prevAge = this.globalTime - this.pBirth[prevSlot];
			// Validate prev: must be older than us and still alive
			this.pPrev[slot] = prevAge >= 0 && prevAge < MAX_AGE ? prevSlot : -1;
		} else {
			this.pPrev[slot] = -1;
		}

		this.entityLastIdx.set(entityId, slot);
		this.writeIdx++;
	}

	/** Stop emitting for this entity. Existing points remain and fade. */
	detach(entityId: number): void {
		this.entityLastIdx.delete(entityId);
		this.entityEmitTimer.delete(entityId);
	}

	/** Detach all entities not in the given active set. */
	detachMissing(activeIds: Set<number>): void {
		for (const id of this.entityLastIdx.keys()) {
			if (!activeIds.has(id)) {
				this.entityLastIdx.delete(id);
				this.entityEmitTimer.delete(id);
			}
		}
	}

	/** Rebuild geometry from all alive points. Call once per frame. */
	update(dt: number, zoom: number): void {
		this.globalTime += dt;

		const posAttr = this.geometry.attributes.position as THREE.BufferAttribute;
		const alphaAttr = this.geometry.attributes.aAlpha as THREE.BufferAttribute;
		const positions = posAttr.array as Float32Array;
		const alphas = alphaAttr.array as Float32Array;

		const pixelsToWorld = 2 / (zoom * SQRT6);
		let vi = 0;

		const count = Math.min(this.writeIdx, MAX_WAKE_POINTS);

		for (let i = 0; i < count; i++) {
			const age = this.globalTime - this.pBirth[i];
			if (age < 0 || age > MAX_AGE) continue;

			const pi = this.pPrev[i];
			if (pi < 0) continue;

			const prevAge = this.globalTime - this.pBirth[pi];
			if (prevAge < 0 || prevAge > MAX_AGE) continue;

			// Prev slot was overwritten if its birth is newer than ours
			if (this.pBirth[pi] > this.pBirth[i]) continue;

			// Break chain if points are too far apart (teleport/respawn)
			const dx = this.px[i] - this.px[pi];
			const dz = this.pz[i] - this.pz[pi];
			if (dx * dx + dz * dz > MAX_SEGMENT_DIST * MAX_SEGMENT_DIST) continue;

			const life = 1 - age / MAX_AGE;
			const prevLife = 1 - prevAge / MAX_AGE;

			// Turbulent centre wake: about a beam wide, spreading as it ages
			const beam = this.pSize[i] * 0.07;
			const spreadRate = this.pSize[i] * 0.004;
			vi = this.buildSegment(
				positions,
				alphas,
				vi,
				i,
				pi,
				life,
				prevLife,
				age,
				prevAge,
				0,
				(l) =>
					Math.max(
						(1.5 + l * 2.0) * pixelsToWorld,
						beam + (1 - l) * MAX_AGE * spreadRate,
					),
				(l) => l ** 1.5 * 0.42,
				0.003,
			);

			// Kelvin arms: faint, and gone well before the centre trail
			const armLife = (l: number) =>
				Math.max(0, (l - ARM_FADE) / (1 - ARM_FADE));
			for (const side of [-1, 1]) {
				vi = this.buildSegment(
					positions,
					alphas,
					vi,
					i,
					pi,
					life,
					prevLife,
					age,
					prevAge,
					side,
					(l) => Math.max((0.8 + l * 1.2) * pixelsToWorld, beam * 0.25),
					(l) => armLife(l) ** 2 * 0.14,
					0.002,
				);
			}
		}

		this.geometry.setDrawRange(0, vi);
		this.root.visible = vi > 0;
		posAttr.needsUpdate = true;
		alphaAttr.needsUpdate = true;
	}

	/**
	 * Build one ribbon segment (2 triangles) between point `idx` and its
	 * predecessor `prevIdx`.
	 *
	 * @param side  0 = center, -1 = left V-spread, 1 = right V-spread
	 * @returns next vertex index
	 */
	private buildSegment(
		positions: Float32Array,
		alphas: Float32Array,
		startVi: number,
		idx: number,
		prevIdx: number,
		life: number,
		prevLife: number,
		age: number,
		prevAge: number,
		side: number,
		halfWidthFn: (life: number) => number,
		alphaFn: (life: number) => number,
		alphaThreshold: number,
	): number {
		const alpha = alphaFn(life);
		const prevAlpha = alphaFn(prevLife);
		if (alpha < alphaThreshold && prevAlpha < alphaThreshold) return startVi;
		let vi = startVi;

		let cx = this.px[idx];
		let cz = this.pz[idx];
		let px = this.px[prevIdx];
		let pz = this.pz[prevIdx];

		// Apply lateral V-spread offset
		if (side !== 0) {
			const spread = age * this.pSpeed[idx] * KELVIN_SPREAD;
			const prevSpread = prevAge * this.pSpeed[prevIdx] * KELVIN_SPREAD;
			const cos = Math.cos(this.pHeading[idx]);
			const sin = Math.sin(this.pHeading[idx]);
			const prevCos = Math.cos(this.pHeading[prevIdx]);
			const prevSin = Math.sin(this.pHeading[prevIdx]);
			cx += -sin * side * spread;
			cz += cos * side * spread;
			px += -prevSin * side * prevSpread;
			pz += prevCos * side * prevSpread;
		}

		// Direction from prev to current
		let dx = cx - px;
		let dz = cz - pz;
		const len = Math.sqrt(dx * dx + dz * dz);
		if (len < 0.001) return vi;
		dx /= len;
		dz /= len;

		// Perpendicular in XZ plane
		const nx = -dz;
		const nz = dx;

		const hw = halfWidthFn(life);
		const prevHw = halfWidthFn(prevLife);

		// Triangle 1: prev-left, prev-right, curr-left
		const b1 = vi * 3;
		positions[b1] = px + nx * prevHw;
		positions[b1 + 1] = WATER_Y;
		positions[b1 + 2] = pz + nz * prevHw;
		alphas[vi] = prevAlpha;
		vi++;

		positions[b1 + 3] = px - nx * prevHw;
		positions[b1 + 4] = WATER_Y;
		positions[b1 + 5] = pz - nz * prevHw;
		alphas[vi] = prevAlpha;
		vi++;

		positions[b1 + 6] = cx + nx * hw;
		positions[b1 + 7] = WATER_Y;
		positions[b1 + 8] = cz + nz * hw;
		alphas[vi] = alpha;
		vi++;

		// Triangle 2: prev-right, curr-left, curr-right
		const b2 = vi * 3;
		positions[b2] = px - nx * prevHw;
		positions[b2 + 1] = WATER_Y;
		positions[b2 + 2] = pz - nz * prevHw;
		alphas[vi] = prevAlpha;
		vi++;

		positions[b2 + 3] = cx + nx * hw;
		positions[b2 + 4] = WATER_Y;
		positions[b2 + 5] = cz + nz * hw;
		alphas[vi] = alpha;
		vi++;

		positions[b2 + 6] = cx - nx * hw;
		positions[b2 + 7] = WATER_Y;
		positions[b2 + 8] = cz - nz * hw;
		alphas[vi] = alpha;
		vi++;

		return vi;
	}

	dispose(): void {
		this.geometry.dispose();
		(this.root.material as THREE.Material).dispose();
	}
}
