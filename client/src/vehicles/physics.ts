/**
 * Naval vehicle physics simulation.
 *
 * Force-based propulsion: engine thrust fights quadratic drag (F ∝ v²).
 * Top speed is emergent — equilibrium where thrust equals drag.
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

export type VehicleType =
	| "speedboat"
	| "frigate"
	| "oil_tanker"
	| "truck"
	| "quadcopter"
	| "shahed";

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

	// --- Force-based propulsion ---

	/** Effective mass for F=ma. */
	mass: number;
	/** Maximum thrust force from engine. */
	enginePower: number;
	/** Quadratic drag coefficient: F_drag = dragCoefficient * v². */
	dragCoefficient: number;
	/** Max turn rate at full speed (radians/sec) */
	turnRate: number;
	/** How much turning generates lateral drift. Higher = more stern kick. */
	driftFactor: number;
	/** Lateral drag per second. Lower = drift damps faster. Higher = drift persists. */
	lateralDrag: number;

	/**
	 * Minimum steering effectiveness at zero speed (0–1).
	 * Ships: 0 (rudder needs water flow). Wheeled vehicles: >0 (can steer while crawling).
	 */
	minTurnFraction: number;

	/**
	 * Fixed forward speed (0 = manual throttle control).
	 * When > 0, the vehicle always flies at this speed — throttle input is ignored.
	 */
	cruiseSpeed: number;

	/** Airborne vehicles ignore terrain slopes and don't produce wakes. */
	airborne: boolean;

	// Visual scale (game units)
	size: number;

	/** Angular velocity in radians/sec (set by collision impulse or propeller torque). */
	angularVelocity: number;

	/** Angular drag per second. Lower = angular velocity damps faster. */
	angularDrag: number;

	// --- Propeller torque steering (ships only) ---

	/** Propeller position as fraction of size, negative = stern. 0 = use turnRate model. */
	propellerOffset: number;
	/** Maximum rudder deflection in radians (~0.6 = 35°). */
	rudderMaxAngle: number;
	/** Yaw moment of inertia (rotational resistance). */
	momentOfInertia: number;
	/** Rudder force from forward motion (water flow over rudder). 0 = outboard steering. */
	rudderFlowCoefficient: number;

	// --- Flooding (progressive damage) ---

	/** Water level 0 = dry, 1 = fully sunk. */
	floodLevel: number;
	/** Roll angle from asymmetric flooding (port negative, starboard positive). */
	listAngle: number;
	/** Number of hull breaches (drives water ingress rate). */
	hullBreaches: number;
	/** Accumulated breach side bias, clamped [-1, 1]. */
	breachSide: number;
}

/** Emergent top speed where engine thrust equals quadratic drag. */
export function equilibriumSpeed(v: NavalVehicle): number {
	return Math.sqrt(v.enginePower / v.dragCoefficient);
}

// ---------------------------------------------------------------------------
// Flooding constants (exported for playground GUI binding)
// ---------------------------------------------------------------------------

export const FLOOD = {
	/** Water ingress rate per breach per second. Single breach: ~30s to sink. */
	breachRate: 0.03,
	/** Max roll angle from asymmetric flooding (~29°). */
	maxList: 0.5,
	/** How quickly list angle develops (exponential lerp rate). */
	lerpRate: 3,
	/** Same-side hits needed for maximum list. */
	breachClampCount: 1,
	/** Additional drag multiplier at full flood (2.5x total drag). */
	floodDragFactor: 1.5,
};

/** Create a hull breach on the given side (-1 port, 0 center, +1 starboard). */
export function addBreach(v: NavalVehicle, side: number): void {
	v.hullBreaches++;
	v.breachSide = Math.max(
		-1,
		Math.min(1, v.breachSide + side / FLOOD.breachClampCount),
	);
}

/** Advance flooding simulation by dt seconds. Call after updateVehicle. */
export function updateFlooding(v: NavalVehicle, dt: number): void {
	if (v.hullBreaches === 0 || v.airborne || v.vehicleType === "truck") return;

	// Water ingress accelerates as ship takes on more water
	const ingress = v.hullBreaches * FLOOD.breachRate * (1 + v.floodLevel);
	v.floodLevel = Math.min(v.floodLevel + ingress * dt, 1);

	// List toward damaged side, proportional to flood level
	const targetList = v.breachSide * FLOOD.maxList * v.floodLevel;
	v.listAngle += (targetList - v.listAngle) * (1 - Math.exp(-FLOOD.lerpRate * dt));

	// Flooding increases drag (ship slows as it rides lower)
	const floodDrag =
		v.floodLevel *
		FLOOD.floodDragFactor *
		v.dragCoefficient *
		v.speed *
		Math.abs(v.speed);
	v.speed -= (floodDrag / v.mass) * dt;
}

export function createSpeedboat(x: number, y: number): NavalVehicle {
	return {
		vehicleType: "speedboat",
		x,
		y,
		heading: 0,
		speed: 0,
		drift: 0,
		mass: 100,
		enginePower: 1200,
		dragCoefficient: 1200 / (26 * 26),
		turnRate: 0,
		driftFactor: 0,
		lateralDrag: 0.12,
		minTurnFraction: 0,
		cruiseSpeed: 0,
		airborne: false,
		size: 10,
		angularVelocity: 0,
		angularDrag: 0.15,
		propellerOffset: -0.4,
		rudderMaxAngle: 0.6,
		momentOfInertia: 714,
		rudderFlowCoefficient: 0, // outboard steering
		floodLevel: 0,
		listAngle: 0,
		hullBreaches: 0,
		breachSide: 0,
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
		mass: 1000,
		enginePower: 4000,
		dragCoefficient: 4000 / (13.5 * 13.5),
		turnRate: 0,
		driftFactor: 0,
		lateralDrag: 0.2,
		minTurnFraction: 0,
		cruiseSpeed: 0,
		airborne: false,
		size: 100,
		angularVelocity: 0,
		angularDrag: 0.25,
		propellerOffset: -0.4,
		rudderMaxAngle: 0.6,
		momentOfInertia: 435000,
		rudderFlowCoefficient: 0.5 * 4000 / (13.5 * 13.5), // ~50% of thrust effect at cruise
		floodLevel: 0,
		listAngle: 0,
		hullBreaches: 0,
		breachSide: 0,
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
		mass: 2200,
		enginePower: 4400,
		dragCoefficient: 4400 / (15 * 15),
		turnRate: 0,
		driftFactor: 0,
		lateralDrag: 0.45,
		minTurnFraction: 0,
		cruiseSpeed: 0,
		airborne: false,
		size: 220,
		angularVelocity: 0,
		angularDrag: 0.3,
		propellerOffset: -0.4,
		rudderMaxAngle: 0.6,
		momentOfInertia: 3600000,
		rudderFlowCoefficient: 0.5 * 4400 / (15 * 15), // ~50% of thrust effect at cruise
		floodLevel: 0,
		listAngle: 0,
		hullBreaches: 0,
		breachSide: 0,
	};
}

export function createTruck(x: number, y: number): NavalVehicle {
	// ~7m box truck (about half a speedboat's length)
	return {
		vehicleType: "truck",
		x,
		y,
		heading: 0,
		speed: 0,
		drift: 0,
		mass: 50,
		enginePower: 400,
		dragCoefficient: 400 / (18 * 18),
		turnRate: 0.8,
		driftFactor: 0.015,
		lateralDrag: 0.04,
		minTurnFraction: 0.6,
		cruiseSpeed: 0,
		airborne: false,
		size: 5,
		angularVelocity: 0,
		angularDrag: 0.1,
		propellerOffset: 0,
		rudderMaxAngle: 0,
		momentOfInertia: 0,
		rudderFlowCoefficient: 0,
		floodLevel: 0,
		listAngle: 0,
		hullBreaches: 0,
		breachSide: 0,
	};
}

export function createQuadcopter(x: number, y: number): NavalVehicle {
	return {
		vehicleType: "quadcopter",
		x,
		y,
		heading: 0,
		speed: 0,
		drift: 0,
		mass: 20,
		enginePower: 360,
		dragCoefficient: 360 / (22 * 22),
		turnRate: 4.0,
		driftFactor: 0.01,
		lateralDrag: 0.05,
		minTurnFraction: 1.0,
		cruiseSpeed: 0,
		airborne: true,
		size: 2,
		angularVelocity: 0,
		angularDrag: 0.08,
		propellerOffset: 0,
		rudderMaxAngle: 0,
		momentOfInertia: 0,
		rudderFlowCoefficient: 0,
		floodLevel: 0,
		listAngle: 0,
		hullBreaches: 0,
		breachSide: 0,
	};
}

export function createShahed(x: number, y: number): NavalVehicle {
	// Shahed-136 style loitering munition — fixed-wing, always moving forward
	return {
		vehicleType: "shahed",
		x,
		y,
		heading: 0,
		speed: 0,
		drift: 0,
		mass: 40,
		enginePower: 400,
		dragCoefficient: 400 / (80 * 80),
		turnRate: 0.5,
		driftFactor: 0.02,
		lateralDrag: 0.1,
		minTurnFraction: 1.0,
		cruiseSpeed: 68,
		airborne: true,
		size: 4,
		angularVelocity: 0,
		angularDrag: 0.1,
		propellerOffset: 0,
		rudderMaxAngle: 0,
		momentOfInertia: 0,
		rudderFlowCoefficient: 0,
		floodLevel: 0,
		listAngle: 0,
		hullBreaches: 0,
		breachSide: 0,
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
	// --- Angular velocity (from collisions + propeller torque) ---
	v.heading += v.angularVelocity * dt;
	v.angularVelocity *= v.angularDrag ** dt;
	if (Math.abs(v.angularVelocity) < 0.001) v.angularVelocity = 0;

	// --- Compute thrust ---
	let thrust = 0;
	if (input.throttle > 0) {
		thrust = input.throttle * v.enginePower;
	} else if (input.throttle < 0) {
		thrust = input.throttle * v.enginePower * 0.3; // reverse is much weaker
	}

	// --- Steering ---
	const eqSpeed = equilibriumSpeed(v);

	if (v.propellerOffset !== 0) {
		// Propeller torque steering (ships):
		// Rudder deflects thrust vector. Lateral force at stern creates torque.
		// Two sources of water over the rudder:
		//   1. Propeller wash (proportional to thrust)
		//   2. Forward motion (proportional to speed², conventional rudders only)
		const rudderAngle = input.rudder * v.rudderMaxAngle;
		const sinRudder = Math.sin(rudderAngle);
		const propWashForce = -thrust * sinRudder;
		const flowForce =
			-v.rudderFlowCoefficient * v.speed * Math.abs(v.speed) * sinRudder;
		const lateralForce = propWashForce + flowForce;
		const torque = v.propellerOffset * v.size * lateralForce;
		v.angularVelocity += (torque / v.momentOfInertia) * dt;
		v.drift += (lateralForce / v.mass) * dt;
		thrust *= Math.cos(rudderAngle); // forward component reduced by deflection
	} else {
		// Direct steering (trucks, drones):
		// Turn rate scales with speed. Wheeled vehicles can steer at low speed.
		const speedRatio = Math.min(Math.abs(v.speed) / eqSpeed, 1);
		const rudderEffect =
			v.minTurnFraction > 0
				? Math.max(v.minTurnFraction, speedRatio)
				: speedRatio < 0.05
					? 0
					: speedRatio;
		const steerSign = v.speed < 0 ? -1 : 1;
		v.heading +=
			input.rudder * v.turnRate * rudderEffect * steerSign * dt;
		v.drift +=
			input.rudder *
			v.turnRate *
			rudderEffect *
			v.speed *
			v.driftFactor *
			dt;
	}

	// Normalize heading
	v.heading = ((v.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

	// --- Forward thrust and drag ---
	const drag = v.dragCoefficient * v.speed * Math.abs(v.speed);
	v.speed += ((thrust - drag) / v.mass) * dt;

	// Lateral drag (hull resists sideways movement — damps drift)
	v.drift *= v.lateralDrag ** dt;

	// --- Slope force (ground/water vehicles only) ---
	let slopeForceAlongHeading = 0;
	if (!v.airborne) {
		// Gravity component along the terrain gradient projected onto heading.
		// Uphill (positive slope along heading) decelerates, downhill accelerates.
		const grad = getTerrainGradient(v.x, v.y);
		const SLOPE_GRAVITY = 5.0; // tunable — how strongly slopes affect speed
		slopeForceAlongHeading =
			-(grad.dx * Math.cos(v.heading) + grad.dy * Math.sin(v.heading)) *
			SLOPE_GRAVITY;
		v.speed += slopeForceAlongHeading * dt;

		// Lateral slope force (vehicle slides sideways on cross-slopes)
		const slopeForceLateral =
			-(grad.dx * -Math.sin(v.heading) + grad.dy * Math.cos(v.heading)) *
			SLOPE_GRAVITY *
			0.3;
		v.drift += slopeForceLateral * dt;
	}

	// --- Cruise speed (fixed-wing drones — always fly at this speed) ---
	if (v.cruiseSpeed > 0) {
		v.speed = v.cruiseSpeed;
	}

	// --- Clamp ---
	// Small headroom above equilibrium for slope/collision impulses
	v.speed = Math.max(-eqSpeed * 0.2, Math.min(eqSpeed * 1.05, v.speed));
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
