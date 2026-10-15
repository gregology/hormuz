/**
 * Look-around input for the perspective camera views.
 *
 * Mouse: click the view to capture the pointer (Esc releases it), then
 * just move the mouse to look; the wheel zooms. Touch: drag a finger
 * across the view. Movement accumulates between frames and is read with
 * consume(), so the camera turns by exactly what the user moved.
 */

/**
 * Chromium reports the cursor's jump to the lock origin as one huge
 * movement when the pointer is captured (sometimes before
 * `pointerlockchange` fires), and can spike on some platforms. No real
 * mouse movement between two events is this large.
 */
const MAX_EVENT_MOVEMENT = 300;

export interface LookDelta {
	dx: number;
	dy: number;
	wheel: number;
}

export class MouseLook {
	private active = false;
	private dx = 0;
	private dy = 0;
	private wheel = 0;
	private touchId: number | null = null;
	private lastX = 0;
	private lastY = 0;
	/** Whether the pointer was already captured at the previous mousemove. */
	private wasCaptured = false;

	constructor(private readonly element: HTMLElement) {
		element.addEventListener("click", () => {
			if (this.active && !this.captured) element.requestPointerLock?.();
		});
		document.addEventListener("mousemove", (e) => {
			const capturing = this.captured;
			const justCaptured = capturing && !this.wasCaptured;
			this.wasCaptured = capturing;
			if (!this.active || !capturing || justCaptured) return;
			if (
				Math.abs(e.movementX) > MAX_EVENT_MOVEMENT ||
				Math.abs(e.movementY) > MAX_EVENT_MOVEMENT
			) {
				return;
			}
			this.dx += e.movementX;
			this.dy += e.movementY;
		});
		document.addEventListener("pointerlockchange", () => {
			if (!this.captured) this.wasCaptured = false;
		});
		element.addEventListener(
			"wheel",
			(e) => {
				if (!this.active) return;
				e.preventDefault();
				this.wheel += e.deltaY;
			},
			{ passive: false },
		);
		element.addEventListener("pointerdown", (e) => {
			if (!this.active || e.pointerType !== "touch" || this.touchId !== null)
				return;
			this.touchId = e.pointerId;
			this.lastX = e.clientX;
			this.lastY = e.clientY;
		});
		element.addEventListener("pointermove", (e) => {
			if (e.pointerId !== this.touchId) return;
			this.dx += e.clientX - this.lastX;
			this.dy += e.clientY - this.lastY;
			this.lastX = e.clientX;
			this.lastY = e.clientY;
		});
		const endTouch = (e: PointerEvent) => {
			if (e.pointerId === this.touchId) this.touchId = null;
		};
		element.addEventListener("pointerup", endTouch);
		element.addEventListener("pointercancel", endTouch);
	}

	/** Turn look-around on in the perspective views and off elsewhere. */
	set enabled(enabled: boolean) {
		if (enabled === this.active) return;
		this.active = enabled;
		this.touchId = null;
		this.consume();
		if (!enabled && this.captured) document.exitPointerLock();
	}

	get enabled(): boolean {
		return this.active;
	}

	/** True while the mouse pointer is captured for looking around. */
	get captured(): boolean {
		return document.pointerLockElement === this.element;
	}

	/** Movement since the last call. */
	consume(): LookDelta {
		const delta = { dx: this.dx, dy: this.dy, wheel: this.wheel };
		this.dx = 0;
		this.dy = 0;
		this.wheel = 0;
		return delta;
	}
}
