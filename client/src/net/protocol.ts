/**
 * MessagePack protocol constants and decode helpers.
 * Mirrors server/src/hormuz/protocol.py.
 */

import { decode, encode } from "@msgpack/msgpack";

// Server -> Client
export const MSG_FULL_SNAPSHOT = 1;
export const MSG_SNAPSHOT_DELTA = 2;
export const MSG_EVENT = 3;
export const MSG_ASSIGN_VEHICLE = 4;
export const MSG_WAR_COST = 5;

// Client -> Server
export const MSG_INPUT = 10;
export const MSG_HEARTBEAT = 11;

// Vehicle type index -> name
const VEHICLE_TYPES = ["oil_tanker", "shahed", "speedboat", "frigate", "quadcopter"] as const;
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
}

export interface FullSnapshot {
	type: typeof MSG_FULL_SNAPSHOT;
	tick: number;
	entities: EntitySnapshot[];
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
}

export interface GameEvent {
	type: typeof MSG_EVENT;
	eventType: string;
	x: number;
	y: number;
}

export type ServerMessage = FullSnapshot | AssignVehicle | WarCost | GameEvent;

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
		}));
		return { type: MSG_FULL_SNAPSHOT, tick, entities };
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
		};
	}

	if (msgType === MSG_EVENT) {
		return {
			type: MSG_EVENT,
			eventType: msg[1] as string,
			x: msg[2] as number,
			y: msg[3] as number,
		};
	}

	return null;
}

export function encodeInput(
	keys: number,
	mouseX: number,
	mouseY: number,
	action: number,
	throttleFloat: number,
	autopilot: boolean,
): Uint8Array {
	return encode([
		MSG_INPUT,
		keys,
		mouseX,
		mouseY,
		action,
		throttleFloat,
		autopilot ? 1 : 0,
	]) as Uint8Array;
}

