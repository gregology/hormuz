/**
 * Keyboard input manager — tracks pressed keys and encodes as bitmask.
 *
 * Bitmask layout (used for shaheds — hold-to-move):
 *   bit 0 (0x01): W            (forward)
 *   bit 1 (0x02): S            (reverse)
 *   bit 2 (0x04): A / ArrowLeft  (port / left)
 *   bit 3 (0x08): D / ArrowRight (starboard / right)
 *   bit 4 (0x10): Space          (action)
 *
 * Ships use stepped throttle (ArrowUp/W increment, ArrowDown/S decrement).
 */

export class KeyboardManager {
	private keys = new Set<string>();

	// Stepped throttle: -10 (full reverse) to +10 (full ahead)
	private _throttleLevel = 0;

	// Autopilot state (client-side, sent to server each frame)
	private _autopilotOn = true;
	private _autopilotToggled = false;
	private _steerInputThisFrame = false;

	constructor() {
		window.addEventListener("keydown", (e) => {
			const key = e.key.toLowerCase();

			// Stepped throttle: ArrowUp/W increment, ArrowDown/S decrement
			if (key === "arrowup" || key === "w") {
				this._throttleLevel = Math.min(10, this._throttleLevel + 1);
				if (key === "arrowup") e.preventDefault();
			} else if (key === "arrowdown" || key === "s") {
				this._throttleLevel = Math.max(-10, this._throttleLevel - 1);
				if (key === "arrowdown") e.preventDefault();
			}

			// Autopilot toggle: P key, edge-triggered (ignore key repeat)
			if (key === "p" && !e.repeat) {
				this._autopilotOn = !this._autopilotOn;
				this._autopilotToggled = true;
			}

			// Detect steering input (A/D/ArrowLeft/ArrowRight)
			if (
				key === "a" ||
				key === "arrowleft" ||
				key === "d" ||
				key === "arrowright"
			) {
				this._steerInputThisFrame = true;
			}

			this.keys.add(key);
			if (e.key === " ") {
				e.preventDefault();
			}
		});
		window.addEventListener("keyup", (e) => {
			this.keys.delete(e.key.toLowerCase());
		});
		// Clear keys when window loses focus
		window.addEventListener("blur", () => this.keys.clear());
	}

	isDown(key: string): boolean {
		return this.keys.has(key);
	}

	getBitmask(): number {
		let mask = 0;
		// W/S for shahed hold-to-move (ArrowUp/Down now control stepped throttle)
		if (this.keys.has("w")) mask |= 0x01;
		if (this.keys.has("s")) mask |= 0x02;
		if (this.keys.has("a") || this.keys.has("arrowleft")) mask |= 0x04;
		if (this.keys.has("d") || this.keys.has("arrowright")) mask |= 0x08;
		if (this.keys.has(" ")) mask |= 0x10;
		return mask;
	}

	// --- Stepped throttle ---

	get throttleLevel(): number {
		return this._throttleLevel;
	}

	get throttleFloat(): number {
		return this._throttleLevel / 10.0;
	}

	set throttleLevel(level: number) {
		this._throttleLevel = Math.max(-10, Math.min(10, level));
	}

	// --- Autopilot ---

	get autopilotOn(): boolean {
		return this._autopilotOn;
	}

	set autopilotOn(v: boolean) {
		this._autopilotOn = v;
	}

	/** Returns true if P was pressed since last call. Resets the flag. */
	consumeAutopilotToggle(): boolean {
		const toggled = this._autopilotToggled;
		this._autopilotToggled = false;
		return toggled;
	}

	/** Returns true if A/D/ArrowLeft/ArrowRight was pressed since last call. Resets the flag. */
	consumeSteerInput(): boolean {
		const had = this._steerInputThisFrame;
		this._steerInputThisFrame = false;
		return had;
	}
}
