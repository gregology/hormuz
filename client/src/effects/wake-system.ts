/**
 * Global wake system — single-draw-call ring buffer for all ship wakes.
 *
 * All entities write wake points into a shared ring buffer. Points are
 * completely independent of the entity that created them — when an entity
 * dies or leaves, its points remain and fade naturally. This eliminates
 * the "magic disappearing wake" artifact and scales to hundreds of ships
 * with a single GPU draw call.
 *
 * Each point stores a `prevIdx` linking it to the previous point in the
 * same entity's trail. Every link becomes one quad spanning the whole
 * Kelvin wedge at that distance behind the ship, and the fragment shader
 * draws the wake procedurally in wake-space coordinates (distance behind
 * the ship, distance from the track):
 *   - a turbulent, foamy core about a beam wide that ages into a smooth,
 *     glassy slick,
 *   - Kelvin arms at 19.5°: a band of choppy water that breaks into
 *     whitecaps near the bow and dies out a few dozen lengths astern,
 * with wavelengths that grow with speed (λ ∝ v²) and a lit, glossy
 * surface so crests catch the sun and sky like the sea around them.
 */

import {
	attribute,
	cameraViewMatrix,
	clamp,
	dFdx,
	dFdy,
	exp,
	float,
	fwidth,
	max,
	mix,
	mx_noise_float,
	normalize,
	positionWorld,
	select,
	smoothstep,
	time,
	vec2,
	vec3,
	vec4,
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

/** One quad (2 triangles) per link between consecutive points. */
const MAX_VERTICES = MAX_WAKE_POINTS * 6;

/** Kelvin wedge half-angle: tan(19.47°). */
const KELVIN_TAN = 0.3536;
/** The wedge starts at the bow, about this fraction of a length ahead of the stern point. */
const BOW_TO_STERN = 0.9;
/** Geometry extends past the arm line so the arms can fade out on both sides. */
const ARM_MARGIN = 1.2;
/** Turbulent core half-width as a fraction of ship size (≈ half the beam). */
const CORE_HALF_WIDTH = 0.06;
/** Kelvin arms die out within this many ship lengths astern (wedge geometry stops growing there). */
const ARM_REACH = 18;

export class WakeSystem {
	readonly root: THREE.Mesh;

	// Ring buffer — struct-of-arrays for cache-friendly iteration
	private readonly px = new Float32Array(MAX_WAKE_POINTS);
	private readonly pz = new Float32Array(MAX_WAKE_POINTS);
	private readonly pHeading = new Float32Array(MAX_WAKE_POINTS);
	private readonly pSpeed = new Float32Array(MAX_WAKE_POINTS);
	private readonly pSize = new Float32Array(MAX_WAKE_POINTS);
	private readonly pStrength = new Float32Array(MAX_WAKE_POINTS);
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

	private readonly geometry: THREE.BufferGeometry;
	private readonly positions: THREE.BufferAttribute;
	/** along (world units behind the ship), side (-1..1), half-width, age (s) */
	private readonly wake: THREE.BufferAttribute;
	/** core half-width, strength (0..1), wavelength, ship size */
	private readonly ship: THREE.BufferAttribute;
	/** Unit direction of travel when the point was laid. */
	private readonly track: THREE.BufferAttribute;

	constructor() {
		this.positions = new THREE.BufferAttribute(
			new Float32Array(MAX_VERTICES * 3),
			3,
		);
		this.wake = new THREE.BufferAttribute(
			new Float32Array(MAX_VERTICES * 4),
			4,
		);
		this.ship = new THREE.BufferAttribute(
			new Float32Array(MAX_VERTICES * 4),
			4,
		);
		this.track = new THREE.BufferAttribute(
			new Float32Array(MAX_VERTICES * 2),
			2,
		);
		for (const attribute of [
			this.positions,
			this.wake,
			this.ship,
			this.track,
		]) {
			attribute.setUsage(THREE.DynamicDrawUsage);
		}
		this.geometry = new THREE.BufferGeometry();
		this.geometry.setAttribute("position", this.positions);
		this.geometry.setAttribute("aWake", this.wake);
		this.geometry.setAttribute("aShip", this.ship);
		this.geometry.setAttribute("aTrack", this.track);
		this.geometry.setDrawRange(0, 0);

		this.root = new THREE.Mesh(this.geometry, createWakeMaterial());
		this.root.frustumCulled = false;
		this.root.renderOrder = 2;
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
		maxSpeed: number,
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
		this.pStrength[slot] = Math.min(Math.abs(speed) / maxSpeed, 1);
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

		// Keep the turbulent core at least a couple of pixels wide when zoomed out.
		const minCoreHalfWidth = 2.5 / (zoom * SQRT6);
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

			vi = this.writeQuad(vi, pi, prevAge, i, age, minCoreHalfWidth);
		}

		this.geometry.setDrawRange(0, vi);
		this.root.visible = vi > 0;
		for (const attribute of [
			this.positions,
			this.wake,
			this.ship,
			this.track,
		]) {
			attribute.clearUpdateRanges();
			attribute.addUpdateRange(0, vi * attribute.itemSize);
			attribute.needsUpdate = true;
		}
	}

	/** Write the quad linking point `a` (older) to point `b` (newer). */
	private writeQuad(
		startVi: number,
		a: number,
		ageA: number,
		b: number,
		ageB: number,
		minCoreHalfWidth: number,
	): number {
		const corners: [number, number, number][] = [
			[a, ageA, -1],
			[a, ageA, 1],
			[b, ageB, -1],
			[b, ageB, 1],
		];
		const order = [0, 1, 2, 1, 3, 2];
		let vi = startVi;
		for (const corner of order) {
			const [point, age, side] = corners[corner];
			const size = this.pSize[point];
			const along = age * this.pSpeed[point];
			const coreHalfWidth = Math.max(size * CORE_HALF_WIDTH, minCoreHalfWidth);
			const armAlong = Math.min(along, size * ARM_REACH);
			const armLine =
				coreHalfWidth + (armAlong + size * BOW_TO_STERN) * KELVIN_TAN;
			const halfWidth = Math.max(armLine * ARM_MARGIN, coreHalfWidth * 3);
			// The wedge spreads perpendicular to the ship's heading when the point was laid.
			const dirX = Math.cos(this.pHeading[point]);
			const dirZ = Math.sin(this.pHeading[point]);
			const nx = -dirZ;
			const nz = dirX;
			const strength = this.pStrength[point];

			this.positions.setXYZ(
				vi,
				this.px[point] + nx * halfWidth * side,
				WATER_Y,
				this.pz[point] + nz * halfWidth * side,
			);
			this.wake.setXYZW(vi, along, side, halfWidth, age);
			this.ship.setXYZW(
				vi,
				coreHalfWidth,
				strength,
				wavelength(size, strength),
				size,
			);
			vi++;
		}
		return vi;
	}

	dispose(): void {
		this.geometry.dispose();
		(this.root.material as THREE.Material).dispose();
	}
}

/** Kelvin wavelength grows with the square of speed; scaled to hull size for the game's compressed scale. */
function wavelength(size: number, strength: number): number {
	return size * (0.05 + 0.13 * strength * strength);
}

function createWakeMaterial(): THREE.MeshStandardNodeMaterial {
	const wake = attribute<"vec4">("aWake", "vec4");
	const ship = attribute<"vec4">("aShip", "vec4");
	const track = attribute<"vec2">("aTrack", "vec2");
	const along = wake.x;
	const signedLateral = wake.y.mul(wake.z);
	const lateral = signedLateral.abs();
	const armLine = wake.z.div(ARM_MARGIN);
	const age = wake.w;
	const coreHalfWidth = ship.x;
	const strength = ship.y;
	const lambda = ship.z;
	const size = ship.w;

	const xz = positionWorld.xz;
	const footprint = max(fwidth(xz.x), fwidth(xz.y));
	// Wave detail fades out before it would alias.
	const waveDetail = smoothstep(2, 6, lambda.div(footprint));

	// --- Turbulent core ---
	// Foam stays where the propellers left it, so its texture uses world
	// coordinates aligned with the track: long streaks, finer froth.
	const u = xz.dot(track);
	const v = xz.dot(vec2(track.y.negate(), track.x));
	const coreWidth = coreHalfWidth.mul(along.div(size.mul(5)).add(1));
	const core = float(1).sub(smoothstep(coreWidth.mul(0.3), coreWidth, lateral));
	const streaks = mx_noise_float(
		vec3(
			u.div(coreHalfWidth.mul(6)),
			v.div(coreHalfWidth.mul(0.55)),
			time.mul(0.04),
		),
	);
	const froth = mx_noise_float(
		vec3(xz.div(coreHalfWidth.mul(0.5)), time.mul(0.25)),
	);
	const foamLife = size.mul(0.12).add(8);
	const fresh = exp(age.div(foamLife).negate()).mul(strength.mul(0.7).add(0.3));
	const foam = core
		.mul(
			smoothstep(
				0.05,
				0.55,
				streaks.mul(0.55).add(froth.mul(0.35)).add(fresh.mul(1.1)).sub(0.35),
			),
		)
		.mul(fresh);
	// Behind the foam: a long trail of paler, bubbly water.
	const aerated = core
		.mul(exp(age.div(foamLife.mul(4)).negate()))
		.mul(strength.mul(0.6).add(0.4));

	// --- Kelvin arms: a narrow band of choppy water travelling with the ship ---
	const armBand = exp(lateral.sub(armLine).abs().div(lambda.mul(-0.9))).mul(
		smoothstep(coreWidth, coreWidth.mul(2.5), lateral),
	);
	const armFade = exp(along.div(size.mul(-ARM_REACH * 0.3)))
		.mul(strength)
		.mul(waveDetail);
	const chop = mx_noise_float(
		vec3(
			along.div(lambda.mul(2.4)),
			signedLateral.div(lambda.mul(0.45)),
			time.mul(0.5),
		),
	);
	const height = chop.mul(1.8).mul(armBand).mul(armFade);
	const bright = smoothstep(0.1, 0.55, height);
	const dark = smoothstep(0.1, 0.55, height.negate());
	// Close to the bow the arms break into whitecaps.
	const whitecaps = smoothstep(0.45, 0.8, chop)
		.mul(armBand)
		.mul(exp(along.div(size.mul(-1.2))))
		.mul(strength)
		.mul(waveDetail);

	// Bump normal from the wave height, via screen-space derivatives, so
	// crests catch the sun and sky like the sea around them.
	const dpdx = dFdx(xz);
	const dpdy = dFdy(xz);
	// (TSL's derivative typings only take vectors.)
	const dhdx = dFdx(vec2(height, 0)).x;
	const dhdy = dFdy(vec2(height, 0)).x;
	const det = dpdx.x.mul(dpdy.y).sub(dpdx.y.mul(dpdy.x));
	const safeDet = select(det.abs().lessThan(1e-9), float(1e-9), det);
	const gradX = dhdx.mul(dpdy.y).sub(dhdy.mul(dpdx.y)).div(safeDet);
	const gradZ = dpdx.x.mul(dhdy).sub(dpdy.x.mul(dhdx)).div(safeDet);
	const slope = lambda.mul(0.05);
	const normal = normalize(
		vec3(gradX.mul(slope).negate(), 1, gradZ.mul(slope).negate()),
	);

	const foamColor = vec3(0.88, 0.91, 0.92);
	const aeratedColor = vec3(0.32, 0.52, 0.55);
	const crestColor = vec3(0.6, 0.72, 0.76);
	const troughColor = vec3(0.01, 0.04, 0.055);
	let color = mix(
		troughColor,
		crestColor,
		bright.div(bright.add(dark).add(1e-4)),
	);
	color = mix(color, aeratedColor, clamp(aerated.mul(1.5), 0, 1));
	color = mix(color, foamColor, clamp(foam.add(whitecaps).mul(1.4), 0, 1));

	const fadeOut = float(1).sub(smoothstep(MAX_AGE * 0.75, MAX_AGE, age));
	const opacity = clamp(
		foam
			.add(whitecaps)
			.mul(0.92)
			.add(aerated.mul(0.32))
			.add(bright.mul(0.32))
			.add(dark.mul(0.22)),
		0,
		1,
	).mul(fadeOut);

	const material = new THREE.MeshStandardNodeMaterial({
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
	});
	material.colorNode = color;
	// Foam is matte; disturbed water is glossier than the open sea, so it glints.
	material.roughnessNode = mix(
		float(0.05),
		float(0.85),
		clamp(foam.mul(1.5), 0, 1),
	);
	material.metalnessNode = float(0);
	material.normalNode = normalize(cameraViewMatrix.mul(vec4(normal, 0)).xyz);
	material.opacityNode = opacity;
	return material;
}
