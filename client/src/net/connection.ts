/**
 * WebSocket connection manager.
 */

import {
	type AssignVehicle,
	type FullSnapshot,
	type InputCommand,
	MSG_ASSIGN_VEHICLE,
	MSG_EVENTS,
	MSG_FULL_SNAPSHOT,
	MSG_WAR_COST,
	type TickEvents,
	type WarCost,
	decodeMessage,
	encodeCommand,
} from "./protocol";

type SnapshotHandler = (snapshot: FullSnapshot) => void;
type AssignHandler = (msg: AssignVehicle) => void;
type WarCostHandler = (msg: WarCost) => void;
type EventsHandler = (msg: TickEvents) => void;

export class GameConnection {
	private ws: WebSocket | null = null;
	private onSnapshotCb: SnapshotHandler | null = null;
	private onAssignCb: AssignHandler | null = null;
	private onWarCostCb: WarCostHandler | null = null;
	private onEventsCb: EventsHandler | null = null;

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
			} else if (msg.type === MSG_EVENTS && this.onEventsCb) {
				this.onEventsCb(msg);
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

	onEvents(cb: EventsHandler): void {
		this.onEventsCb = cb;
	}

	sendCommand(command: InputCommand): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(encodeCommand(command));
	}
}
