/**
 * Keyboard input manager — tracks pressed keys and encodes as bitmask.
 *
 * Bitmask layout:
 *   bit 0 (0x01): W / ArrowUp    (forward)
 *   bit 1 (0x02): S / ArrowDown  (reverse)
 *   bit 2 (0x04): A / ArrowLeft  (port / left)
 *   bit 3 (0x08): D / ArrowRight (starboard / right)
 *   bit 4 (0x10): Space          (action)
 */

export class KeyboardManager {
	private keys = new Set<string>();

	constructor() {
		window.addEventListener("keydown", (e) => {
			this.keys.add(e.key.toLowerCase());
			// Prevent arrow keys from scrolling the page
			if (e.key.startsWith("Arrow") || e.key === " ") {
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
		if (this.keys.has("w") || this.keys.has("arrowup")) mask |= 0x01;
		if (this.keys.has("s") || this.keys.has("arrowdown")) mask |= 0x02;
		if (this.keys.has("a") || this.keys.has("arrowleft")) mask |= 0x04;
		if (this.keys.has("d") || this.keys.has("arrowright")) mask |= 0x08;
		if (this.keys.has(" ")) mask |= 0x10;
		return mask;
	}
}
