/**
 * Naval vehicle physics simulation.
 *
 * Rudder-based turning: ships can only turn when moving — water must flow
 * over the rudder. Turn rate scales linearly with speed (matching real
 * hydrodynamics where rudder force ∝ v²  →  turn rate ∝ v).
 *
 * Turning at speed generates lateral drift (the stern kicks out).
 * Drift damps based on hull resistance — light speedboats skid,
 * heavy tankers slide ominously.
 *
 * Terrain slopes apply a gravity force along the gradient — vehicles
 * decelerate uphill and accelerate downhill.
 */

import { getTerrainGradient } from "../map/heightmap";

export type VehicleType = "speedboat" | "frigate" | "oil_tanker";

export interface NavalVehicle {
	vehicleType: VehicleType;

	// Position in world space
	x: number;
	y: number;

	// Heading in radians (0 = east, PI/2 = south)
	heading: number;

	// Forward speed along heading (units/sec)
	speed: number;

	// Lateral speed perpendicular to heading (positive = starboard drift)
	drift: number;

	// --- Tunable physics parameters ---

	maxSpeed: number;
	acceleration: number;
	/** Forward drag per second (0.9 = lose 10%/sec) */
	drag: number;
	/** Max turn rate at full speed (radians/sec) */
	turnRate: number;
	/** How much turning generates lateral drift. Higher = more stern kick. */
	driftFactor: number;
	/** Lateral drag per second. Lower = drift damps faster. Higher = drift persists. */
	lateralDrag: number;

	// Visual scale (game units)
	size: number;
}

export function createSpeedboat(x: number, y: number): NavalVehicle {
	return {
		vehicleType: "speedboat",
		x,
		y,
		heading: 0,
		speed: 0,
		drift: 0,
		maxSpeed: 26,
		acceleration: 12,
		drag: 0.9,
		turnRate: 2.0,
		driftFactor: 0.04,
		lateralDrag: 0.12,
		size: 10,
	};
}

export function createFrigate(x: number, y: number): NavalVehicle {
	// ~10x longer than speedboat (real: 150m vs 15m)
	return {
		vehicleType: "frigate",
		x,
		y,
		heading: 0,
		speed: 0,
		drift: 0,
		maxSpeed: 13.5,
		acceleration: 4,
		drag: 0.95,
		turnRate: 0.15,
		driftFactor: 0.1,
		lateralDrag: 0.2,
		size: 100,
	};
}

export function createOilTanker(x: number, y: number): NavalVehicle {
	// ~22x longer than speedboat (real: 330m vs 15m)
	return {
		vehicleType: "oil_tanker",
		x,
		y,
		heading: 0,
		speed: 0,
		drift: 0,
		maxSpeed: 7.5,
		acceleration: 1,
		drag: 0.97,
		turnRate: 0.05,
		driftFactor: 0.25,
		lateralDrag: 0.45,
		size: 220,
	};
}

export interface VehicleInput {
	throttle: number; // -1 to 1 (forward/reverse)
	rudder: number; // -1 to 1 (port/starboard)
}

/**
 * Step the vehicle physics forward by dt seconds.
 */
export function updateVehicle(
	v: NavalVehicle,
	input: VehicleInput,
	dt: number,
): void {
	// --- Rudder-based turning ---
	// Turn rate is proportional to speed. No speed = no turning.
	const speedRatio = Math.min(Math.abs(v.speed) / v.maxSpeed, 1);
	// Dead zone: rudder is useless below 5% speed
	const rudderEffect = speedRatio < 0.05 ? 0 : speedRatio;
	const turnAmount = input.rudder * v.turnRate * rudderEffect * dt;
	v.heading += turnAmount;

	// Normalize heading
	v.heading = ((v.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

	// --- Drift from turning ---
	// Turning at speed pushes the stern sideways. The faster and harder
	// the turn, the more drift. Rudder sign determines drift direction.
	v.drift +=
		input.rudder * v.turnRate * rudderEffect * v.speed * v.driftFactor * dt;

	// --- Throttle ---
	if (input.throttle > 0) {
		v.speed += input.throttle * v.acceleration * dt;
	} else if (input.throttle < 0) {
		// Reverse is much weaker
		v.speed += input.throttle * v.acceleration * 0.3 * dt;
	}

	// --- Drag ---
	v.speed *= v.drag ** dt;

	// Lateral drag (hull resists sideways movement — damps drift)
	v.drift *= v.lateralDrag ** dt;

	// --- Slope force ---
	// Gravity component along the terrain gradient projected onto heading.
	// Uphill (positive slope along heading) decelerates, downhill accelerates.
	const grad = getTerrainGradient(v.x, v.y);
	const SLOPE_GRAVITY = 5.0; // tunable — how strongly slopes affect speed
	const slopeForceAlongHeading =
		-(grad.dx * Math.cos(v.heading) + grad.dy * Math.sin(v.heading)) *
		SLOPE_GRAVITY;
	v.speed += slopeForceAlongHeading * dt;

	// Lateral slope force (vehicle slides sideways on cross-slopes)
	const slopeForceLateral =
		-(grad.dx * -Math.sin(v.heading) + grad.dy * Math.cos(v.heading)) *
		SLOPE_GRAVITY *
		0.3;
	v.drift += slopeForceLateral * dt;

	// --- Clamp ---
	v.speed = Math.max(-v.maxSpeed * 0.2, Math.min(v.maxSpeed, v.speed));
	if (
		Math.abs(v.speed) < 0.05 &&
		input.throttle === 0 &&
		Math.abs(slopeForceAlongHeading) < 0.1
	)
		v.speed = 0;
	if (Math.abs(v.drift) < 0.02) v.drift = 0;

	// --- Move ---
	// Forward along heading + lateral perpendicular to heading
	const cos = Math.cos(v.heading);
	const sin = Math.sin(v.heading);
	v.x += (cos * v.speed - sin * v.drift) * dt;
	v.y += (sin * v.speed + cos * v.drift) * dt;
}
