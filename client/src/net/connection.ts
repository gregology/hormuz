/**
 * WebSocket connection manager.
 */

import {
	type AssignVehicle,
	type FullSnapshot,
	type GameEvent,
	MSG_ASSIGN_VEHICLE,
	MSG_EVENT,
	MSG_FULL_SNAPSHOT,
	MSG_WAR_COST,
	type WarCost,
	decodeMessage,
	encodeInput,
} from "./protocol";

type SnapshotHandler = (snapshot: FullSnapshot) => void;
type AssignHandler = (msg: AssignVehicle) => void;
type WarCostHandler = (msg: WarCost) => void;
type EventHandler = (msg: GameEvent) => void;

export class GameConnection {
	private ws: WebSocket | null = null;
	private onSnapshotCb: SnapshotHandler | null = null;
	private onAssignCb: AssignHandler | null = null;
	private onWarCostCb: WarCostHandler | null = null;
	private onEventCb: EventHandler | null = null;

	connect(url: string): void {
		this.ws = new WebSocket(url);
		this.ws.binaryType = "arraybuffer";

		this.ws.onmessage = (ev: MessageEvent) => {
			const msg = decodeMessage(ev.data as ArrayBuffer);
			if (!msg) return;

			if (msg.type === MSG_FULL_SNAPSHOT && this.onSnapshotCb) {
				this.onSnapshotCb(msg);
			} else if (msg.type === MSG_ASSIGN_VEHICLE && this.onAssignCb) {
				this.onAssignCb(msg);
			} else if (msg.type === MSG_WAR_COST && this.onWarCostCb) {
				this.onWarCostCb(msg);
			} else if (msg.type === MSG_EVENT && this.onEventCb) {
				this.onEventCb(msg);
			}
		};
	}

	onSnapshot(cb: SnapshotHandler): void {
		this.onSnapshotCb = cb;
	}

	onAssign(cb: AssignHandler): void {
		this.onAssignCb = cb;
	}

	onWarCost(cb: WarCostHandler): void {
		this.onWarCostCb = cb;
	}

	onEvent(cb: EventHandler): void {
		this.onEventCb = cb;
	}

	sendInput(keys: number, throttleFloat: number, autopilot: boolean): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(encodeInput(keys, 0, 0, 0, throttleFloat, autopilot));
		}
	}
}
