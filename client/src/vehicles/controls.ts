/**
 * How a player's input command drives their vehicle.
 *
 * Mirrors server/src/hormuz/controls.py, which applies the commands for
 * real; the client uses it to predict the player's own vehicle.
 * shared/physics_fixtures.json pins the two together.
 */

import { JAM_RADIUS, VEHICLE_PHYSICS } from "../generated/vehicles";
import type { VehicleInput, VehicleType } from "./physics";

export const KEY_FORWARD = 0x01;
export const KEY_REVERSE = 0x02;
export const KEY_LEFT = 0x04;
export const KEY_RIGHT = 0x08;

/** Shaheds lose steering to frigates' jammers; quadcopters fly autonomously through them. */
const JAMMABLE: ReadonlySet<string> = new Set(["shahed"]);

/**
 * Throttle and rudder for one command. `nearJammer` says whether a
 * frigate's jammer reaches the vehicle; it searches the world, so it's only
 * asked when jamming would matter.
 */
export function vehicleControls(
	vehicleType: VehicleType,
	keys: number,
	throttle: number,
	nearJammer: () => boolean = () => false,
): VehicleInput {
	let rudder = (keys & KEY_RIGHT ? 1 : 0) - (keys & KEY_LEFT ? 1 : 0);
	// Drones are hold-to-move; ships keep the throttle the player stepped to.
	const drive = VEHICLE_PHYSICS[vehicleType].airborne
		? (keys & KEY_FORWARD ? 1 : 0) - (keys & KEY_REVERSE ? 1 : 0)
		: Math.max(-1, Math.min(1, throttle));
	if (rudder !== 0 && JAMMABLE.has(vehicleType) && nearJammer()) rudder = 0;
	return { throttle: drive, rudder };
}

interface Located {
	vehicleType: string;
	x: number;
	y: number;
	hp: number;
}

/** Whether a living frigate's jammer reaches this point. */
export function withinJammingRange(
	x: number,
	y: number,
	entities: readonly Located[],
): boolean {
	return entities.some(
		(e) =>
			e.vehicleType === "frigate" &&
			e.hp > 0 &&
			(e.x - x) ** 2 + (e.y - y) ** 2 < JAM_RADIUS ** 2,
	);
}
