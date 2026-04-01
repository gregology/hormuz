/**
 * Input manager — merges keyboard and touch input into a single interface.
 *
 * On desktop (no touch), this is a thin pass-through to KeyboardManager.
 * On touch devices, it OR-merges bitmasks and flags from both sources.
 * KeyboardManager is never modified — touch feeds into it via callbacks.
 */

import { type CameraMode, KeyboardManager } from "./keyboard";
import { TouchManager } from "./touch";
import { TouchOverlay } from "./touch-overlay";

export class InputManager {
	readonly keyboard: KeyboardManager;
	readonly touch: TouchManager | null;
	readonly overlay: TouchOverlay | null;
	readonly isMobile: boolean;

	constructor(container: HTMLElement) {
		this.keyboard = new KeyboardManager();
		this.isMobile = TouchManager.isTouchDevice();

		if (this.isMobile) {
			this.touch = new TouchManager({
				onThrottleAdjust: (delta) => {
					this.keyboard.throttleLevel = this.keyboard.throttleLevel + delta;
				},
				onCycleCameraMode: () => {
					this.keyboard.cycleCameraMode();
				},
			});
			this.overlay = new TouchOverlay(container, this.touch);
		} else {
			this.touch = null;
			this.overlay = null;
		}
	}

	// --- Merged interface ---

	getBitmask(): number {
		const kb = this.keyboard.getBitmask();
		const tc = this.touch?.getBitmask() ?? 0;
		return kb | tc;
	}

	get throttleLevel(): number {
		return this.keyboard.throttleLevel;
	}

	set throttleLevel(level: number) {
		this.keyboard.throttleLevel = level;
	}

	get throttleFloat(): number {
		return this.keyboard.throttleFloat;
	}

	get autopilotOn(): boolean {
		return this.keyboard.autopilotOn;
	}

	set autopilotOn(v: boolean) {
		this.keyboard.autopilotOn = v;
		this.overlay?.updateAutopilotState(v);
	}

	consumeAutopilotToggle(): boolean {
		const kb = this.keyboard.consumeAutopilotToggle();
		const tc = this.touch?.consumeAutopilotToggle() ?? false;
		return kb || tc;
	}

	consumeSteerInput(): boolean {
		const kb = this.keyboard.consumeSteerInput();
		const tc = this.touch?.consumeSteerInput() ?? false;
		return kb || tc;
	}

	isDown(key: string): boolean {
		return this.keyboard.isDown(key) || (this.touch?.isDown(key) ?? false);
	}

	get cameraMode(): CameraMode {
		return this.keyboard.cameraMode;
	}

	consumeCameraModeChange(): boolean {
		return this.keyboard.consumeCameraModeChange();
	}

	// --- Vehicle/state updates ---

	updateVehicleType(vehicleType: string): void {
		const isShip =
			vehicleType === "oil_tanker" ||
			vehicleType === "frigate" ||
			vehicleType === "speedboat";
		this.touch?.setVehicleMode(isShip ? "ship" : "drone");
		this.overlay?.updateVehicleType(vehicleType);
	}

	updateSpectating(spectating: boolean, hasPendingAssign: boolean): void {
		this.overlay?.updateSpectating(spectating, hasPendingAssign);
	}
}
