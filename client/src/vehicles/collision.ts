/**
 * Collision detection and resolution for vehicles.
 *
 * Terrain collisions use coastline polygon data (point-in-polygon).
 *
 * Vehicle collisions use the Separating Axis Theorem (SAT) on convex
 * polygons — each vehicle type has a collision polygon that matches its
 * hull shape. SAT returns the collision normal, penetration depth, and
 * contact point, which feed into impulse-based rigid body resolution.
 */

import { isLand, isWater } from "../map/terrain";
import type { NavalVehicle, VehicleType } from "./physics";

export { COLLISION_POLYGONS } from "../generated/vehicles";
import { COLLISION_POLYGONS } from "../generated/vehicles";

// Pre-compute bounding radius per vehicle type
const BOUNDING_RADIUS: Record<string, number> = {};
for (const [type, verts] of Object.entries(COLLISION_POLYGONS)) {
	let maxR = 0;
	for (const [x, y] of verts) {
		maxR = Math.max(maxR, Math.sqrt(x * x + y * y));
	}
	BOUNDING_RADIUS[type] = maxR;
}

// Physics constants
const RESTITUTION = 0.3;
const FRICTION = 0.4;

// ---------------------------------------------------------------------------
// SAT types and helpers
// ---------------------------------------------------------------------------

interface SATResult {
	normal: [number, number]; // collision normal, points from A toward B
	depth: number; // penetration depth
	contact: [number, number]; // contact point in world space
}

/** Transform local-space polygon to world space. */
function transformPolygon(
	verts: [number, number][],
	x: number,
	y: number,
	heading: number,
	size: number,
): [number, number][] {
	const cos = Math.cos(heading);
	const sin = Math.sin(heading);
	return verts.map(([lx, ly]) => [
		x + (lx * cos - ly * sin) * size,
		y + (lx * sin + ly * cos) * size,
	]);
}

/** Project all vertices onto an axis, return [min, max]. */
function projectPolygon(
	poly: [number, number][],
	ax: number,
	ay: number,
): [number, number] {
	let min = poly[0][0] * ax + poly[0][1] * ay;
	let max = min;
	for (let i = 1; i < poly.length; i++) {
		const d = poly[i][0] * ax + poly[i][1] * ay;
		if (d < min) min = d;
		if (d > max) max = d;
	}
	return [min, max];
}

/** Full SAT collision test between two convex polygons. */
function satCollision(
	polyA: [number, number][],
	polyB: [number, number][],
	centerAx: number,
	centerAy: number,
	centerBx: number,
	centerBy: number,
): SATResult | null {
	let minDepth = Number.POSITIVE_INFINITY;
	let minNx = 0;
	let minNy = 0;

	// Test all edge normals from both polygons
	const polys = [polyA, polyB];
	for (const poly of polys) {
		const n = poly.length;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			// Edge vector
			const ex = poly[j][0] - poly[i][0];
			const ey = poly[j][1] - poly[i][1];
			// Outward normal (perpendicular, unnormalized)
			let nx = -ey;
			let ny = ex;
			const len = Math.sqrt(nx * nx + ny * ny);
			if (len < 1e-10) continue;
			nx /= len;
			ny /= len;

			// Project both polygons
			const [minA, maxA] = projectPolygon(polyA, nx, ny);
			const [minB, maxB] = projectPolygon(polyB, nx, ny);

			// Check overlap
			const overlap = Math.min(maxA - minB, maxB - minA);
			if (overlap <= 0) return null; // separating axis found

			if (overlap < minDepth) {
				minDepth = overlap;
				minNx = nx;
				minNy = ny;
			}
		}
	}

	// Ensure normal points from A toward B
	const dx = centerBx - centerAx;
	const dy = centerBy - centerAy;
	if (minNx * dx + minNy * dy < 0) {
		minNx = -minNx;
		minNy = -minNy;
	}

	// Compute contact point: find the deepest penetrating vertex
	// Project all vertices of B onto -normal; the one with smallest projection is deepest into A
	let bestDepthA = Number.NEGATIVE_INFINITY;
	let contactAx = 0;
	let contactAy = 0;
	for (const [vx, vy] of polyB) {
		const d = -(vx * minNx + vy * minNy);
		if (d > bestDepthA) {
			bestDepthA = d;
			contactAx = vx;
			contactAy = vy;
		}
	}

	let bestDepthB = Number.NEGATIVE_INFINITY;
	let contactBx = 0;
	let contactBy = 0;
	for (const [vx, vy] of polyA) {
		const d = vx * minNx + vy * minNy;
		if (d > bestDepthB) {
			bestDepthB = d;
			contactBx = vx;
			contactBy = vy;
		}
	}

	// Use the average of both candidate contact points
	const cx = (contactAx + contactBx) * 0.5;
	const cy = (contactAy + contactBy) * 0.5;

	return {
		normal: [minNx, minNy],
		depth: minDepth,
		contact: [cx, cy],
	};
}

// ---------------------------------------------------------------------------
// Terrain collision (unchanged — point-based)
// ---------------------------------------------------------------------------

/**
 * Check and resolve terrain collisions for a single vehicle.
 * Call after updateVehicle() with the position from before the update.
 * Returns true if a collision occurred.
 */
export function resolveTerrainCollision(
	v: NavalVehicle,
	prevX: number,
	prevY: number,
): boolean {
	if (v.airborne) return false;

	let blocked = false;

	if (
		v.vehicleType === "speedboat" ||
		v.vehicleType === "frigate" ||
		v.vehicleType === "oil_tanker"
	) {
		blocked = isLand(v.x, v.y);
	} else if (v.vehicleType === "truck") {
		blocked = isWater(v.x, v.y);
	}

	if (!blocked) return false;

	v.x = prevX;
	v.y = prevY;
	v.speed *= -0.3;
	v.drift = 0;
	v.angularVelocity = 0;
	return true;
}

// ---------------------------------------------------------------------------
// Vehicle-vehicle collision (SAT + impulse)
// ---------------------------------------------------------------------------

/**
 * Detect and resolve all pairwise vehicle-vehicle collisions using
 * SAT on convex hull polygons with impulse-based rigid body resolution.
 *
 * Runs multiple iterations so that deep penetrations (fast vehicles
 * crossing narrow hulls in a single frame) are fully resolved.
 */
export function resolveVehicleCollisions(vehicles: NavalVehicle[]): void {
	const iterations = 3;
	for (let iter = 0; iter < iterations; iter++) {
		for (let i = 0; i < vehicles.length; i++) {
			for (let j = i + 1; j < vehicles.length; j++) {
				resolveCollisionPair(vehicles[i], vehicles[j]);
			}
		}
	}
}

function resolveCollisionPair(a: NavalVehicle, b: NavalVehicle): void {
	// Broad phase: bounding circle check
	const brA = (BOUNDING_RADIUS[a.vehicleType] ?? 0.5) * a.size;
	const brB = (BOUNDING_RADIUS[b.vehicleType] ?? 0.5) * b.size;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const distSq = dx * dx + dy * dy;
	const brSum = brA + brB;
	if (distSq > brSum * brSum) return;

	// Get collision polygons
	const vertsA = COLLISION_POLYGONS[a.vehicleType];
	const vertsB = COLLISION_POLYGONS[b.vehicleType];
	if (!vertsA || !vertsB) return;

	// Transform to world space
	const polyA = transformPolygon(vertsA, a.x, a.y, a.heading, a.size);
	const polyB = transformPolygon(vertsB, b.x, b.y, b.heading, b.size);

	// Narrow phase: SAT
	const result = satCollision(polyA, polyB, a.x, a.y, b.x, b.y);
	if (!result) return;

	const [nx, ny] = result.normal;
	const overlap = result.depth;
	const [cx, cy] = result.contact;

	// --- Mass and inertia (area-proportional mass) ---
	const massA = a.size * a.size;
	const massB = b.size * b.size;
	const totalMass = massA + massB;
	const invMassA = 1.0 / massA;
	const invMassB = 1.0 / massB;

	const iRadA = brA;
	const iRadB = brB;
	const iA = massA * iRadA * iRadA;
	const iB = massB * iRadB * iRadB;
	const invIA = 1.0 / iA;
	const invIB = 1.0 / iB;

	// --- Position correction (mass-weighted separation) ---
	a.x -= nx * overlap * (massB / totalMass);
	a.y -= ny * overlap * (massB / totalMass);
	b.x += nx * overlap * (massA / totalMass);
	b.y += ny * overlap * (massA / totalMass);

	// --- Contact point offset from centers ---
	const rAx = cx - a.x;
	const rAy = cy - a.y;
	const rBx = cx - b.x;
	const rBy = cy - b.y;

	// --- Convert speed/drift to world-space linear velocity ---
	const cosA = Math.cos(a.heading);
	const sinA = Math.sin(a.heading);
	const cosB = Math.cos(b.heading);
	const sinB = Math.sin(b.heading);

	let vAx = cosA * a.speed - sinA * a.drift;
	let vAy = sinA * a.speed + cosA * a.drift;
	let vBx = cosB * b.speed - sinB * b.drift;
	let vBy = sinB * b.speed + cosB * b.drift;

	let omegaA = a.angularVelocity;
	let omegaB = b.angularVelocity;

	// --- Velocity at contact point: v + omega x r ---
	const vcAx = vAx - omegaA * rAy;
	const vcAy = vAy + omegaA * rAx;
	const vcBx = vBx - omegaB * rBy;
	const vcBy = vBy + omegaB * rBx;

	// Relative velocity at contact
	const vrelX = vcAx - vcBx;
	const vrelY = vcAy - vcBy;
	const vrelN = vrelX * nx + vrelY * ny;

	// Bodies separating — don't apply impulse
	if (vrelN < 0) return;

	// --- Normal impulse ---
	const rAxN = rAx * ny - rAy * nx;
	const rBxN = rBx * ny - rBy * nx;

	const denom = invMassA + invMassB + rAxN * rAxN * invIA + rBxN * rBxN * invIB;
	const jNormal = (-(1 + RESTITUTION) * vrelN) / denom;

	const jNx = jNormal * nx;
	const jNy = jNormal * ny;

	vAx += jNx * invMassA;
	vAy += jNy * invMassA;
	vBx -= jNx * invMassB;
	vBy -= jNy * invMassB;

	omegaA += (rAx * jNy - rAy * jNx) * invIA;
	omegaB -= (rBx * jNy - rBy * jNx) * invIB;

	// --- Friction impulse (tangential) ---
	const tx = -ny;
	const ty = nx;
	const vrelT = vrelX * tx + vrelY * ty;

	const rAxT = rAx * ty - rAy * tx;
	const rBxT = rBx * ty - rBy * tx;
	const denomT =
		invMassA + invMassB + rAxT * rAxT * invIA + rBxT * rBxT * invIB;

	let jTangent = -vrelT / denomT;

	const maxFriction = Math.abs(jNormal) * FRICTION;
	if (Math.abs(jTangent) > maxFriction) {
		jTangent = Math.sign(jTangent) * maxFriction;
	}

	const jTx = jTangent * tx;
	const jTy = jTangent * ty;

	vAx += jTx * invMassA;
	vAy += jTy * invMassA;
	vBx -= jTx * invMassB;
	vBy -= jTy * invMassB;

	omegaA += (rAx * jTy - rAy * jTx) * invIA;
	omegaB -= (rBx * jTy - rBy * jTx) * invIB;

	// --- Convert back to speed/drift ---
	a.speed = vAx * cosA + vAy * sinA;
	a.drift = -vAx * sinA + vAy * cosA;
	a.angularVelocity = omegaA;

	b.speed = vBx * cosB + vBy * sinB;
	b.drift = -vBx * sinB + vBy * cosB;
	b.angularVelocity = omegaB;
}
