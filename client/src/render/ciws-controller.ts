/**
 * CIWS (Phalanx-style) autocannon controller.
 *
 * Manages per-frigate turret targeting, rate-limited rotation, burst firing,
 * and tracer/muzzle-flash particles. The turret geometry lives on the frigate
 * mesh (see vehicle-meshes.ts); this controller rotates it and spawns visual
 * projectiles.
 *
 * All targeting is client-side cosmetic — the server remains authoritative
 * for actual damage.
 */

import * as THREE from "three/webgpu";
import type { EntityState } from "../game/entities";
import {
	AUTOCANNON,
	DETECTION_RANGE,
	VEHICLE_PHYSICS,
} from "../generated/vehicles";
import { ParticleBatch } from "./particles";
import { CIWS_MUZZLE_OFFSET, CIWS_TURRET_POS } from "./vehicle-models";

// ---------------------------------------------------------------------------
// Tunable parameters (exposed for playground GUI)
// Server-shared values sourced from YAML; visual-only params are local.
// ---------------------------------------------------------------------------

const CIWS_PARAMS = {
	/** Turret rotation speed in rad/s. */
	rotationSpeed: Math.PI,
	/** Seconds between burst starts. */
	burstCooldown: AUTOCANNON.cooldown,
	/** Duration of each firing burst in seconds. */
	burstDuration: 0.3,
	/** Tracers spawned per second during a burst. */
	tracerRate: 40,
	/** Engagement range in game units. */
	range: AUTOCANNON.range,
	/** Tracer speed in game units/s. */
	projectileSpeed: AUTOCANNON.projectileSpeed,
	/** Random angular spread per tracer (radians) — wider than server for visual effect. */
	spread: 0.04,
	/** Turret must be within this angle of target to fire (radians). */
	aimTolerance: 0.15,
	/** Tracer lifetime in seconds. */
	tracerMaxAge: 2.5,
	/** Base tracer point size (pixels at zoom=1). */
	tracerSize: 5,
	/** Muzzle-flash particle size multiplier (relative to tracerSize). */
	muzzleFlashScale: 4,
	/** Muzzle-flash lifetime in seconds. */
	muzzleFlashDuration: 0.06,
};

type CiwsParams = typeof CIWS_PARAMS;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRIGATE_SIZE = VEHICLE_PHYSICS.frigate.size;
const MAX_TRACERS = 512;
const SQRT6 = Math.sqrt(6);

// Frigate detection range² per target type (from radar model)
const FRIGATE_DET = DETECTION_RANGE.frigate ?? {};
const RADAR_RANGE_SQ: Record<string, number> = Object.fromEntries(
	Object.entries(FRIGATE_DET).map(([k, v]) => [k, (v ?? 0) * (v ?? 0)]),
);

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CiwsState {
	turretAngle: number; // world-space aim direction (radians)
	targetId: number | null;
	cooldown: number; // seconds until next burst can start
	burstRemaining: number; // seconds left in current burst (0 = not firing)
	tracerAccum: number; // accumulator for tracer spawn timing
}

interface Tracer {
	x: number; // game X (Three.js X)
	y: number; // game Y (Three.js Z)
	height: number; // Three.js Y
	vx: number; // game X velocity
	vy: number; // game Y velocity
	vh: number; // vertical velocity (slight arc)
	age: number;
	maxAge: number;
	isMuzzleFlash: boolean;
}

// ---------------------------------------------------------------------------
// Angle helpers
// ---------------------------------------------------------------------------

function normalizeAngle(angle: number): number {
	let a = angle % (Math.PI * 2);
	if (a > Math.PI) a -= Math.PI * 2;
	if (a < -Math.PI) a += Math.PI * 2;
	return a;
}

function angleDiff(from: number, to: number): number {
	return normalizeAngle(to - from);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class CiwsController {
	readonly root: THREE.Group;
	readonly params: CiwsParams;

	private states = new Map<number, CiwsState>();
	private tracers: Tracer[] = [];

	private particles = new ParticleBatch(MAX_TRACERS, {
		shape: "glow",
		additive: true,
		renderOrder: 9,
	});

	constructor(params?: CiwsParams) {
		this.params = params ?? CIWS_PARAMS;
		this.root = new THREE.Group();
		this.root.add(this.particles.object);
	}

	/**
	 * Per-frame update. Call after the vehicle renderer has positioned meshes.
	 *
	 * @param getCiwsTurret  Callback to retrieve the turret THREE.Group for a
	 *                       frigate entity (typically `renderer.getCiwsTurret`).
	 */
	update(
		entities: EntityState[],
		getCiwsTurret: (entityId: number) => THREE.Group | null,
		dt: number,
		zoom: number,
	): void {
		const p = this.params;

		// Classify entities
		const frigates: EntityState[] = [];
		const drones: EntityState[] = [];
		for (const e of entities) {
			if (e.hp <= 0) continue;
			if (e.vehicleType === "frigate") frigates.push(e);
			else if (
				e.vehicleType === "shahed" ||
				e.vehicleType === "quadcopter" ||
				e.vehicleType === "speedboat"
			)
				drones.push(e);
		}

		// Prune states for removed frigates
		const frigateIds = new Set(frigates.map((f) => f.id));
		for (const id of this.states.keys()) {
			if (!frigateIds.has(id)) this.states.delete(id);
		}

		const rangeSq = p.range * p.range;

		for (const f of frigates) {
			let state = this.states.get(f.id);
			if (!state) {
				state = {
					turretAngle: f.heading,
					targetId: null,
					cooldown: 0,
					burstRemaining: 0,
					tracerAccum: 0,
				};
				this.states.set(f.id, state);
			}

			const turretGroup = getCiwsTurret(f.id);

			// --- Target acquisition ---
			// Validate current target (must be on radar AND in autocannon range)
			if (state.targetId !== null) {
				const t = drones.find((d) => d.id === state.targetId);
				if (!t) {
					state.targetId = null;
				} else {
					const dx = t.x - f.x;
					const dy = t.y - f.y;
					const distSq = dx * dx + dy * dy;
					const radarSq = RADAR_RANGE_SQ[t.vehicleType] ?? 0;
					if (distSq > rangeSq || distSq > radarSq) state.targetId = null;
				}
			}

			// Acquire nearest drone on radar and in autocannon range
			if (state.targetId === null) {
				let bestDist = rangeSq;
				for (const d of drones) {
					const dx = d.x - f.x;
					const dy = d.y - f.y;
					const distSq = dx * dx + dy * dy;
					const radarSq = RADAR_RANGE_SQ[d.vehicleType] ?? 0;
					if (distSq < bestDist && distSq <= radarSq) {
						bestDist = distSq;
						state.targetId = d.id;
					}
				}
			}

			// --- Turret rotation ---
			const target =
				state.targetId !== null
					? (drones.find((d) => d.id === state.targetId) ?? null)
					: null;

			if (target) {
				// Lead targeting: predict where target will be at intercept
				const dx = target.x - f.x;
				const dy = target.y - f.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const tIntercept = dist / p.projectileSpeed;
				const tvx = Math.cos(target.heading) * target.speed;
				const tvy = Math.sin(target.heading) * target.speed;
				const predX = target.x + tvx * tIntercept;
				const predY = target.y + tvy * tIntercept;

				const desiredAngle = Math.atan2(predY - f.y, predX - f.x);
				const diff = angleDiff(state.turretAngle, desiredAngle);
				const maxStep = p.rotationSpeed * dt;

				if (Math.abs(diff) <= maxStep) {
					state.turretAngle = desiredAngle;
				} else {
					state.turretAngle += Math.sign(diff) * maxStep;
				}
				state.turretAngle = normalizeAngle(state.turretAngle);
			}

			// Apply rotation to turret mesh
			if (turretGroup) {
				turretGroup.rotation.y = f.heading - state.turretAngle;
			}

			// --- Firing ---
			state.cooldown -= dt;

			const aimed =
				target !== null &&
				Math.abs(
					angleDiff(
						state.turretAngle,
						Math.atan2(target.y - f.y, target.x - f.x),
					),
				) < p.aimTolerance;

			if (aimed && state.cooldown <= 0 && state.burstRemaining <= 0) {
				state.burstRemaining = p.burstDuration;
				state.cooldown = p.burstCooldown;
				state.tracerAccum = 0;
			}

			if (state.burstRemaining > 0) {
				state.burstRemaining -= dt;
				state.tracerAccum += dt;
				const interval = 1 / p.tracerRate;

				while (state.tracerAccum >= interval) {
					state.tracerAccum -= interval;
					this.spawnTracer(f, state);
				}
			}
		}

		// --- Update tracers ---
		this.updateTracers(dt, zoom);
	}

	private spawnTracer(frigate: EntityState, state: CiwsState): void {
		if (this.tracers.length >= MAX_TRACERS) return;
		const p = this.params;

		// Compute muzzle world position
		const cosH = Math.cos(frigate.heading);
		const sinH = Math.sin(frigate.heading);
		const turretX =
			frigate.x +
			(CIWS_TURRET_POS.x * cosH - CIWS_TURRET_POS.z * sinH) * FRIGATE_SIZE;
		const turretY =
			frigate.y +
			(CIWS_TURRET_POS.x * sinH + CIWS_TURRET_POS.z * cosH) * FRIGATE_SIZE;

		const cosT = Math.cos(state.turretAngle);
		const sinT = Math.sin(state.turretAngle);
		const muzzleX =
			turretX +
			(CIWS_MUZZLE_OFFSET.x * cosT - CIWS_MUZZLE_OFFSET.z * sinT) *
				FRIGATE_SIZE;
		const muzzleY =
			turretY +
			(CIWS_MUZZLE_OFFSET.x * sinT + CIWS_MUZZLE_OFFSET.z * cosT) *
				FRIGATE_SIZE;
		// Frigates ride the sea surface (y = 0).
		const muzzleHeight =
			(CIWS_TURRET_POS.y + CIWS_MUZZLE_OFFSET.y) * FRIGATE_SIZE;

		// Aim angle with random spread
		const aimAngle = state.turretAngle + (Math.random() - 0.5) * 2 * p.spread;

		const vx = Math.cos(aimAngle) * p.projectileSpeed;
		const vy = Math.sin(aimAngle) * p.projectileSpeed;

		// Tracer
		this.tracers.push({
			x: muzzleX,
			y: muzzleY,
			height: muzzleHeight,
			vx,
			vy,
			vh: -2, // slight downward arc (gravity-ish)
			age: 0,
			maxAge: p.tracerMaxAge,
			isMuzzleFlash: false,
		});

		// Muzzle flash particle (large, very short-lived)
		this.tracers.push({
			x: muzzleX,
			y: muzzleY,
			height: muzzleHeight,
			vx: 0,
			vy: 0,
			vh: 0,
			age: 0,
			maxAge: p.muzzleFlashDuration,
			isMuzzleFlash: true,
		});
	}

	private updateTracers(dt: number, zoom: number): void {
		const p = this.params;
		const pixelScale = zoom * SQRT6;

		// Advance and prune
		for (const t of this.tracers) {
			t.x += t.vx * dt;
			t.y += t.vy * dt;
			t.height += t.vh * dt;
			t.age += dt;
		}
		this.tracers = this.tracers.filter((t) => t.age < t.maxAge);

		this.particles.clear();
		for (const t of this.tracers) {
			const life = t.age / t.maxAge;
			let alpha: number;
			let size: number;

			if (t.isMuzzleFlash) {
				// Bright flash that fades quickly
				alpha = 1.0 - life;
				size =
					p.tracerSize * p.muzzleFlashScale * (1.0 - life * 0.5) * pixelScale;
			} else {
				// Tracer: full brightness for most of life, fade at end
				alpha = life < 0.7 ? 0.9 : 0.9 * (1.0 - (life - 0.7) / 0.3);
				size = p.tracerSize * pixelScale;
			}

			if (alpha < 0.01 || size < 0.3) continue;

			// HDR yellow-orange so tracers and flashes bloom.
			const heat = t.isMuzzleFlash ? 2 : 1;
			this.particles.push(
				t.x,
				t.height,
				t.y,
				size,
				3.6 * heat,
				1.7 * heat,
				0.35 * heat,
				alpha,
			);
		}
		this.particles.commit();
	}

	dispose(): void {
		this.particles.dispose();
	}
}
