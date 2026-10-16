/**
 * Client-side prediction of the player's own vehicle.
 *
 * Everything else is drawn from snapshots, slightly in the past. The
 * player's vehicle runs in the present instead: each input command is
 * applied the moment it's issued, with the same physics the server will run
 * (`vehicles/physics.ts`), so the vehicle answers the controls without waiting
 * a round trip and the camera following it moves along a smooth curve.
 *
 * Each snapshot says which commands the server has applied. Prediction
 * restarts from the server's state and replays the rest. Whatever it got
 * wrong (collisions, damage, anything else the client doesn't simulate) is
 * taken out of view over `CORRECTION_TIME` rather than in one jump.
 */

import { TICK_RATE, VEHICLE_PHYSICS } from "../generated/vehicles";
import {
	type NavalVehicle,
	type VehicleInput,
	type VehicleType,
	createVehicle,
	updateVehicle,
} from "../vehicles/physics";
import type { EntityState } from "./entities";
import {
	type Motion,
	type Point,
	angleBetween,
	headingBetween,
	positionBetween,
} from "./motion";

const TICK_INTERVAL = 1 / TICK_RATE;

/** Time for a correction to fade to 1/e (seconds). */
const CORRECTION_TIME = 0.1;

/**
 * Corrections bigger than this many vehicle lengths happen at once: the
 * vehicle respawned or was moved, and gliding there would only mislead.
 */
const SNAP_LENGTHS = 3;

/** Unapplied commands kept for replay; the server never holds this many. */
const MAX_PENDING = 2 * TICK_RATE;

interface PendingCommand {
	sequence: number;
	controls: VehicleInput;
}

interface Followed {
	entityId: number;
	vehicleType: VehicleType;
}

interface Correction {
	x: number;
	y: number;
	heading: number;
}

const NO_CORRECTION: Correction = { x: 0, y: 0, heading: 0 };

export class VehiclePredictor {
	private followed: Followed | null = null;
	private vehicle: NavalVehicle | null = null;
	/** The latest predicted states, oldest first, one tick apart. */
	private recent: Motion[] = [];
	private pending: PendingCommand[] = [];
	private correction = NO_CORRECTION;

	/** The entity being predicted, or null. */
	get entityId(): number | null {
		return this.followed?.entityId ?? null;
	}

	/** The newest predicted position, once a snapshot of the vehicle has arrived. */
	get position(): Point | null {
		return this.vehicle && { x: this.vehicle.x, y: this.vehicle.y };
	}

	/** Predict this entity from its next snapshot on. */
	follow(entityId: number, vehicleType: VehicleType): void {
		this.followed = { entityId, vehicleType };
		this.vehicle = null;
		this.recent = [];
		this.pending = [];
		this.correction = NO_CORRECTION;
	}

	stop(): void {
		this.followed = null;
		this.vehicle = null;
		this.recent = [];
		this.pending = [];
	}

	/** Apply a command the moment it's issued, as the server will when it arrives. */
	apply(sequence: number, controls: VehicleInput): void {
		if (!this.followed) return;
		this.pending.push({ sequence, controls });
		if (this.pending.length > MAX_PENDING) this.pending.shift();
		if (this.vehicle) this.step(this.vehicle, controls);
	}

	/**
	 * Restart from the server's state of the vehicle after it applied command
	 * `lastCommand`, and replay the commands it hasn't applied yet.
	 * `fraction` is where the vehicle is drawn between its last two states,
	 * so that what's on screen doesn't move.
	 */
	reconcile(server: EntityState, lastCommand: number, fraction: number): void {
		const followed = this.followed;
		if (server.id !== followed?.entityId) return;
		const drawn = this.pose(fraction);

		this.pending = this.pending.filter((c) => c.sequence > lastCommand);
		const vehicle = createVehicle(followed.vehicleType, server.x, server.y);
		vehicle.heading = server.heading;
		vehicle.speed = server.speed;
		vehicle.drift = server.drift;
		vehicle.angularVelocity = server.angularVelocity;
		vehicle.floodLevel = server.floodLevel ?? 0;
		vehicle.listAngle = server.listAngle ?? 0;
		this.vehicle = vehicle;
		this.recent = [motionOf(vehicle)];
		for (const command of this.pending) this.step(vehicle, command.controls);
		if (drawn) this.blendFrom(drawn, fraction);
	}

	/**
	 * Draw the vehicle at `drawn` for now and glide from there into its
	 * predicted path: where prediction was drawing it before a correction,
	 * or where snapshots drew it before prediction took over.
	 */
	blendFrom(drawn: Motion, fraction: number): void {
		this.correction = NO_CORRECTION;
		const predicted = this.pose(fraction);
		if (!predicted || !this.followed) return;
		const x = drawn.x - predicted.x;
		const y = drawn.y - predicted.y;
		const size = VEHICLE_PHYSICS[this.followed.vehicleType].size;
		if (Math.hypot(x, y) > SNAP_LENGTHS * size) return;
		this.correction = {
			x,
			y,
			heading: angleBetween(predicted.heading, drawn.heading),
		};
	}

	/** Fade the outstanding correction; call once per frame. */
	settle(dt: number): void {
		const remaining = Math.exp(-dt / CORRECTION_TIME);
		this.correction = {
			x: this.correction.x * remaining,
			y: this.correction.y * remaining,
			heading: this.correction.heading * remaining,
		};
	}

	/** Where to draw the vehicle, `fraction` (0–1) of the way from its previous state to its newest. */
	pose(fraction: number): Motion | null {
		const count = this.recent.length;
		if (count === 0) return null;
		const to = this.recent[count - 1];
		const from = this.recent[count - 2] ?? to;
		const at = positionBetween(
			this.recent[count - 3],
			from,
			to,
			fraction,
			TICK_INTERVAL,
		);
		return {
			x: at.x + this.correction.x,
			y: at.y + this.correction.y,
			heading:
				headingBetween(from.heading, to.heading, fraction) +
				this.correction.heading,
			speed: from.speed + (to.speed - from.speed) * fraction,
			drift: from.drift + (to.drift - from.drift) * fraction,
		};
	}

	private step(vehicle: NavalVehicle, controls: VehicleInput): void {
		updateVehicle(vehicle, controls, TICK_INTERVAL);
		this.recent.push(motionOf(vehicle));
		if (this.recent.length > 3) this.recent.shift();
	}
}

function motionOf(vehicle: NavalVehicle): Motion {
	const { x, y, heading, speed, drift } = vehicle;
	return { x, y, heading, speed, drift };
}
