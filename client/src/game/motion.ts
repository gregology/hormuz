/**
 * Smooth paths through a vehicle's states one tick apart.
 *
 * The simulation moves each vehicle in a straight line per tick, so joining
 * its states with straight lines turns every curve into a polygon. Its
 * corners, one per tick, show as jitter when the camera is close. These
 * paths are cubic Hermite curves through the same states instead: each
 * passes through every state, leaving it in the direction the vehicle was
 * moving there, so the path has no corners.
 */

/** The part of a vehicle's state that says where it is and how it's moving. */
export interface Motion {
	x: number;
	y: number;
	/** Radians, 0 = east, π/2 = south. */
	heading: number;
	/** Along the heading (units/s). */
	speed: number;
	/** Perpendicular to the heading, positive to starboard (units/s). */
	drift: number;
}

export interface Point {
	x: number;
	y: number;
}

/**
 * How far a tick's movement may stray from what the vehicle's own velocity
 * explains, as a fraction of that movement, before the curve gives way to a
 * straight line. Physics alone matches exactly; a collision push or a
 * respawn doesn't, and a curve there would swing wide.
 */
const UNEXPLAINED_MOVEMENT = 0.01;

/**
 * Where a vehicle is `fraction` (0–1) of the way from state `from` to state
 * `to`, `interval` seconds later. `earlier`, the state before `from`, makes
 * the curve leave `from` in the direction it arrived there; without it the
 * curve leaves along `from`'s velocity.
 */
export function positionBetween(
	earlier: Motion | undefined,
	from: Motion,
	to: Motion,
	fraction: number,
	interval: number,
): Point {
	if (!explainsMovement(from, to, interval)) {
		return {
			x: from.x + (to.x - from.x) * fraction,
			y: from.y + (to.y - from.y) * fraction,
		};
	}
	const start = tangent(earlier, from, interval);
	const end = tangent(from, to, interval);
	const u = fraction;
	const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
	const h10 = u ** 3 - 2 * u ** 2 + u;
	const h01 = -2 * u ** 3 + 3 * u ** 2;
	const h11 = u ** 3 - u ** 2;
	return {
		x:
			h00 * from.x +
			h10 * interval * start.x +
			h01 * to.x +
			h11 * interval * end.x,
		y:
			h00 * from.y +
			h10 * interval * start.y +
			h01 * to.y +
			h11 * interval * end.y,
	};
}

/** Heading `fraction` of the way from `from` to `to`, turning the short way round. */
export function headingBetween(
	from: number,
	to: number,
	fraction: number,
): number {
	return from + angleBetween(from, to) * fraction;
}

/** Signed shortest turn from angle `a` to angle `b`, in [-π, π]. */
export function angleBetween(a: number, b: number): number {
	return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/**
 * The simulation moves a vehicle by its velocity after the tick's update,
 * so a tick of plain physics ends exactly where `to`'s velocity says.
 */
function explainsMovement(from: Motion, to: Motion, interval: number): boolean {
	const expected = velocity(to, to.heading);
	const expectedX = expected.x * interval;
	const expectedY = expected.y * interval;
	const unexplained = Math.hypot(
		to.x - from.x - expectedX,
		to.y - from.y - expectedY,
	);
	return (
		unexplained <=
		UNEXPLAINED_MOVEMENT * Math.hypot(expectedX, expectedY) + 1e-6
	);
}

/**
 * The direction of travel through `state`. The heading it reports is the
 * one it arrived along; the path turns smoothly through the state, so its
 * direction there lies half a tick of turning further on.
 */
function tangent(
	before: Motion | undefined,
	state: Motion,
	interval: number,
): Point {
	if (!before || !explainsMovement(before, state, interval)) {
		return velocity(state, state.heading);
	}
	const halfTurn = angleBetween(before.heading, state.heading) / 2;
	return velocity(state, state.heading + halfTurn);
}

function velocity(state: Motion, heading: number): Point {
	const cos = Math.cos(heading);
	const sin = Math.sin(heading);
	return {
		x: cos * state.speed - sin * state.drift,
		y: sin * state.speed + cos * state.drift,
	};
}
