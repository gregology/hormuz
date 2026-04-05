/**
 * Touch input manager — translates virtual d-pad and action button state
 * into the same bitmask/throttle/autopilot interface as KeyboardManager.
 *
 * This class holds pure logic — no DOM. The TouchOverlay wires DOM events
 * into the methods here.
 */

type VehicleMode = "ship" | "drone";

interface TouchCallbacks {
	/** Called when up/down is pressed in ship mode. delta: +1 or -1. */
	onThrottleAdjust: (delta: number) => void;
	/** Called when the camera toggle button is tapped. */
	onCycleCameraMode: () => void;
}

export class TouchManager {
	// D-pad state
	private _up = false;
	private _down = false;
	private _left = false;
	private _right = false;
	private _fire = false;

	// Edge-triggered flags
	private _autopilotToggled = false;
	private _steerInputThisFrame = false;

	private _vehicleMode: VehicleMode = "ship";
	private callbacks: TouchCallbacks;

	// Throttle repeat for ship mode
	private throttleRepeatTimer: ReturnType<typeof setTimeout> | null = null;
	private throttleRepeatInterval: ReturnType<typeof setInterval> | null = null;

	constructor(callbacks: TouchCallbacks) {
		this.callbacks = callbacks;

		// Clear state when app is backgrounded
		document.addEventListener("visibilitychange", () => {
			if (document.hidden) this.releaseAll();
		});
	}

	static isTouchDevice(): boolean {
		return navigator.maxTouchPoints > 0;
	}

	setVehicleMode(mode: VehicleMode): void {
		this._vehicleMode = mode;
	}

	// --- D-pad press/release ---

	setDPad(direction: "up" | "down" | "left" | "right", pressed: boolean): void {
		switch (direction) {
			case "up":
				this._up = pressed;
				if (pressed && this._vehicleMode === "ship") {
					this.startThrottleRepeat(+1);
				} else if (!pressed) {
					this.stopThrottleRepeat();
				}
				break;
			case "down":
				this._down = pressed;
				if (pressed && this._vehicleMode === "ship") {
					this.startThrottleRepeat(-1);
				} else if (!pressed) {
					this.stopThrottleRepeat();
				}
				break;
			case "left":
				this._left = pressed;
				if (pressed) this._steerInputThisFrame = true;
				break;
			case "right":
				this._right = pressed;
				if (pressed) this._steerInputThisFrame = true;
				break;
		}
	}

	setFire(pressed: boolean): void {
		this._fire = pressed;
	}

	toggleAutopilot(): void {
		this._autopilotToggled = true;
	}

	cycleCameraMode(): void {
		this.callbacks.onCycleCameraMode();
	}

	releaseAll(): void {
		this._up = false;
		this._down = false;
		this._left = false;
		this._right = false;
		this._fire = false;
		this.stopThrottleRepeat();
	}

	// --- Read interface (mirrors KeyboardManager) ---

	getBitmask(): number {
		let mask = 0;
		if (this._up) mask |= 0x01;
		if (this._down) mask |= 0x02;
		if (this._left) mask |= 0x04;
		if (this._right) mask |= 0x08;
		if (this._fire) mask |= 0x10;
		return mask;
	}

	consumeAutopilotToggle(): boolean {
		const toggled = this._autopilotToggled;
		this._autopilotToggled = false;
		return toggled;
	}

	consumeSteerInput(): boolean {
		const had = this._steerInputThisFrame;
		this._steerInputThisFrame = false;
		return had;
	}

	isDown(key: string): boolean {
		switch (key) {
			case "w":
			case "arrowup":
				return this._up;
			case "s":
			case "arrowdown":
				return this._down;
			case "a":
			case "arrowleft":
				return this._left;
			case "d":
			case "arrowright":
				return this._right;
			case " ":
				return this._fire;
			default:
				return false;
		}
	}

	// --- Ship throttle repeat ---

	private startThrottleRepeat(delta: number): void {
		this.stopThrottleRepeat();
		// Fire immediately
		this.callbacks.onThrottleAdjust(delta);
		// After 400ms, repeat every 150ms
		this.throttleRepeatTimer = setTimeout(() => {
			this.throttleRepeatInterval = setInterval(() => {
				this.callbacks.onThrottleAdjust(delta);
			}, 150);
		}, 400);
	}

	private stopThrottleRepeat(): void {
		if (this.throttleRepeatTimer !== null) {
			clearTimeout(this.throttleRepeatTimer);
			this.throttleRepeatTimer = null;
		}
		if (this.throttleRepeatInterval !== null) {
			clearInterval(this.throttleRepeatInterval);
			this.throttleRepeatInterval = null;
		}
	}
}
