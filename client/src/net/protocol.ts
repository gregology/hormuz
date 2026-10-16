/**
 * MessagePack protocol constants and decode helpers.
 * Mirrors server/src/hormuz/protocol.py.
 */

import { decode, encode } from "@msgpack/msgpack";

// Server -> Client
export const MSG_FULL_SNAPSHOT = 1;
// const MSG_SNAPSHOT_DELTA = 2;
export const MSG_EVENTS = 3;
export const MSG_ASSIGN_VEHICLE = 4;
export const MSG_WAR_COST = 5;

// Client -> Server
const MSG_INPUT = 10;
// const MSG_HEARTBEAT = 11;

// Vehicle type index -> name
const VEHICLE_TYPES = [
	"oil_tanker",
	"shahed",
	"speedboat",
	"frigate",
	"quadcopter",
] as const;
const FACTION_NAMES = ["civilian", "iran", "us"] as const;

export interface EntitySnapshot {
	id: number;
	vehicleType: string;
	faction: string;
	x: number;
	y: number;
	heading: number;
	speed: number;
	drift: number;
	hp: number;
	angularVelocity: number;
	floodLevel: number;
	listAngle: number;
	batteryPct: number;
}

/** What this client needs to predict the vehicle it drives. */
export interface ControlledVehicle {
	entityId: number;
	/** Sequence number of the newest input command the server has applied (0 before the first). */
	lastCommand: number;
	/** Commands the server has received but not yet applied. */
	bufferedCommands: number;
}

export interface FullSnapshot {
	type: typeof MSG_FULL_SNAPSHOT;
	tick: number;
	entities: EntitySnapshot[];
	/** Null while this client drives nothing. */
	controlled: ControlledVehicle | null;
}

export interface AssignVehicle {
	type: typeof MSG_ASSIGN_VEHICLE;
	entityId: number;
	vehicleType: string;
}

export interface WarCost {
	type: typeof MSG_WAR_COST;
	totalUsd: number;
	tankersDelivered: number;
	tankersSunk: number;
	frigatesSunk: number;
	shahedsIntercepted: number;
	quadcoptersIntercepted: number;
	speedboatsSunk: number;
	playersOnline: number;
}

/** A one-off happening in the world, at a point on the map. */
export type GameEvent =
	| { kind: "explosion"; x: number; y: number }
	| { kind: "delivered"; x: number; y: number }
	| {
			kind: "projectile";
			x: number;
			y: number;
			targetX: number;
			targetY: number;
	  };

/** The events of one server tick, to be played when playback reaches it. */
export interface TickEvents {
	type: typeof MSG_EVENTS;
	tick: number;
	events: GameEvent[];
}

export type ServerMessage = FullSnapshot | AssignVehicle | WarCost | TickEvents;

/** One tick of player input, numbered so the server can say which it has applied. */
export interface InputCommand {
	sequence: number;
	keys: number;
	/** Ship throttle setting, -1 to 1. */
	throttle: number;
	autopilot: boolean;
}

export function decodeMessage(data: ArrayBuffer): ServerMessage | null {
	const msg = decode(new Uint8Array(data)) as unknown[];
	const msgType = msg[0] as number;

	if (msgType === MSG_FULL_SNAPSHOT) {
		const tick = msg[1] as number;
		const raw = msg[2] as unknown[][];
		const entities: EntitySnapshot[] = raw.map((e) => ({
			id: e[0] as number,
			vehicleType: VEHICLE_TYPES[e[1] as number] ?? "unknown",
			faction: FACTION_NAMES[e[2] as number] ?? "unknown",
			x: e[3] as number,
			y: e[4] as number,
			heading: e[5] as number,
			speed: e[6] as number,
			drift: e[7] as number,
			hp: e[8] as number,
			angularVelocity: (e[9] as number) ?? 0,
			floodLevel: (e[10] as number) ?? 0,
			listAngle: (e[11] as number) ?? 0,
			batteryPct: (e[12] as number) ?? -1,
		}));
		const controlled = msg[3] as [number, number, number] | null | undefined;
		return {
			type: MSG_FULL_SNAPSHOT,
			tick,
			entities,
			controlled: controlled
				? {
						entityId: controlled[0],
						lastCommand: controlled[1],
						bufferedCommands: controlled[2],
					}
				: null,
		};
	}

	if (msgType === MSG_ASSIGN_VEHICLE) {
		return {
			type: MSG_ASSIGN_VEHICLE,
			entityId: msg[1] as number,
			vehicleType: msg[2] as string,
		};
	}

	if (msgType === MSG_WAR_COST) {
		return {
			type: MSG_WAR_COST,
			totalUsd: msg[1] as number,
			tankersDelivered: msg[2] as number,
			tankersSunk: msg[3] as number,
			frigatesSunk: (msg[4] as number) ?? 0,
			shahedsIntercepted: (msg[5] as number) ?? 0,
			quadcoptersIntercepted: (msg[6] as number) ?? 0,
			speedboatsSunk: (msg[7] as number) ?? 0,
			playersOnline: (msg[8] as number) ?? 0,
		};
	}

	if (msgType === MSG_EVENTS) {
		const events = (msg[2] as unknown[][]).flatMap((e) => {
			const event = decodeEvent(e);
			return event ? [event] : [];
		});
		return { type: MSG_EVENTS, tick: msg[1] as number, events };
	}

	return null;
}

/** Event types this client doesn't know are dropped. */
function decodeEvent(e: unknown[]): GameEvent | null {
	const [kind, x, y] = e as [string, number, number];
	switch (kind) {
		case "explosion":
		case "delivered":
			return { kind, x, y };
		case "projectile":
			return { kind, x, y, targetX: e[3] as number, targetY: e[4] as number };
		default:
			return null;
	}
}

export function encodeCommand(command: InputCommand): Uint8Array {
	return encode([
		MSG_INPUT,
		command.keys,
		0, // mouse x
		0, // mouse y
		0, // action
		command.throttle,
		command.autopilot ? 1 : 0,
		command.sequence,
	]) as Uint8Array;
}
