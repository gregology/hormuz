/**
 * Touch overlay — creates DOM elements for mobile controls.
 *
 * - D-pad (bottom-left): up/down/left/right arrows
 * - Action buttons (bottom-right): Fire, Autopilot
 * - Portrait orientation gate: "rotate your device" message
 * - Fullscreen request on first touch in landscape
 */

import type { TouchManager } from "./touch";

// SVG arrow for d-pad buttons (points up, rotate via CSS)
const ARROW_SVG = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="12 5 12 19"/><polyline points="5 12 12 5 19 12"/></svg>`;

// Rotation icon for portrait gate
const ROTATE_SVG = `<svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="16" width="24" height="40" rx="4" transform="rotate(-90 32 32)"/><path d="M48 14 a18 18 0 0 1 0 36" /><polyline points="44 50 48 50 48 46"/></svg>`;

export class TouchOverlay {
	readonly root: HTMLDivElement;
	private portraitGate: HTMLDivElement;
	private controls: HTMLDivElement;
	private respawnBtn: HTMLDivElement;
	private autopilotBtn: HTMLDivElement;
	private dpadUp: HTMLDivElement | null = null;
	private dpadDown: HTMLDivElement | null = null;

	private touchManager: TouchManager;
	private requestedFullscreen = false;

	// Track active touches per button to handle multi-touch correctly
	private activeTouches = new Map<HTMLElement, number>();

	constructor(container: HTMLElement, touchManager: TouchManager) {
		this.touchManager = touchManager;

		// --- Root overlay ---
		this.root = document.createElement("div");
		this.root.id = "touch-overlay";
		Object.assign(this.root.style, {
			position: "absolute",
			top: "0",
			left: "0",
			width: "100%",
			height: "100%",
			pointerEvents: "none",
			zIndex: "100",
		} satisfies Partial<CSSStyleDeclaration>);

		// --- Portrait orientation gate ---
		this.portraitGate = this.createPortraitGate();
		this.root.appendChild(this.portraitGate);

		// --- Touch controls container ---
		this.controls = document.createElement("div");
		this.controls.id = "touch-controls";
		Object.assign(this.controls.style, {
			position: "absolute",
			top: "0",
			left: "0",
			width: "100%",
			height: "100%",
			pointerEvents: "none",
		} satisfies Partial<CSSStyleDeclaration>);

		// D-pad
		const dpad = this.createDPad();
		this.controls.appendChild(dpad);

		// Action buttons
		const actions = this.createActionButtons();
		this.controls.appendChild(actions);

		this.autopilotBtn = actions.querySelector(
			"#touch-autopilot",
		) as HTMLDivElement;

		// Respawn button (centered, shown only when dead with pending assign)
		this.respawnBtn = this.createRespawnButton();
		this.controls.appendChild(this.respawnBtn);

		this.root.appendChild(this.controls);
		container.appendChild(this.root);

		// --- Orientation detection ---
		this.updateOrientation();
		const mq = window.matchMedia("(orientation: portrait)");
		mq.addEventListener("change", () => this.updateOrientation());
	}

	// --- Public API ---

	updateVehicleType(vehicleType: string): void {
		this.autopilotBtn.style.display =
			vehicleType === "oil_tanker" ? "flex" : "none";
		const showUpDown = vehicleType !== "shahed";
		if (this.dpadUp)
			this.dpadUp.style.visibility = showUpDown ? "visible" : "hidden";
		if (this.dpadDown)
			this.dpadDown.style.visibility = showUpDown ? "visible" : "hidden";
	}

	updateAutopilotState(on: boolean): void {
		this.autopilotBtn.style.backgroundColor = on
			? "rgba(0, 170, 68, 0.5)"
			: "rgba(100, 100, 100, 0.35)";
		this.autopilotBtn.style.color = on ? "#ffffff" : "#999999";
	}

	updateSpectating(spectating: boolean, hasPendingAssign: boolean): void {
		this.respawnBtn.style.display =
			spectating && hasPendingAssign ? "flex" : "none";
		if (spectating) {
			this.autopilotBtn.style.display = "none";
		}
	}

	dispose(): void {
		this.root.remove();
	}

	// --- Portrait gate ---

	private createPortraitGate(): HTMLDivElement {
		const gate = document.createElement("div");
		gate.id = "portrait-gate";
		Object.assign(gate.style, {
			position: "fixed",
			top: "0",
			left: "0",
			width: "100%",
			height: "100%",
			zIndex: "9999",
			background: "#0a1628",
			display: "none",
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
			gap: "20px",
			color: "#ffffff",
			fontFamily: "monospace",
			fontSize: "16px",
			textAlign: "center",
			padding: "24px",
			pointerEvents: "auto",
		} satisfies Partial<CSSStyleDeclaration>);

		const icon = document.createElement("div");
		icon.innerHTML = ROTATE_SVG;
		icon.style.color = "#88aacc";

		const text = document.createElement("div");
		text.textContent = "Rotate your device to landscape";
		text.style.color = "#aaccdd";

		gate.append(icon, text);
		return gate;
	}

	private updateOrientation(): void {
		const isPortrait = window.matchMedia("(orientation: portrait)").matches;
		this.portraitGate.style.display = isPortrait ? "flex" : "none";
		this.controls.style.display = isPortrait ? "none" : "block";
	}

	// --- D-Pad ---

	private createDPad(): HTMLDivElement {
		const container = document.createElement("div");
		container.id = "dpad-container";
		Object.assign(container.style, {
			position: "absolute",
			bottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
			left: "calc(16px + env(safe-area-inset-left, 0px))",
			display: "grid",
			gridTemplateColumns: "52px 52px 52px",
			gridTemplateRows: "52px 52px 52px",
			gap: "4px",
			pointerEvents: "none",
		} satisfies Partial<CSSStyleDeclaration>);

		// Grid positions: [row, col, direction, rotation]
		const buttons: [
			number,
			number,
			"up" | "down" | "left" | "right",
			string,
		][] = [
			[0, 1, "up", "0deg"],
			[1, 0, "left", "-90deg"],
			[1, 2, "right", "90deg"],
			[2, 1, "down", "180deg"],
		];

		for (const [row, col, direction, rotation] of buttons) {
			const btn = document.createElement("div");
			Object.assign(btn.style, {
				gridRow: String(row + 1),
				gridColumn: String(col + 1),
				width: "52px",
				height: "52px",
				borderRadius: "10px",
				backgroundColor: "rgba(255, 255, 255, 0.12)",
				border: "1px solid rgba(255, 255, 255, 0.2)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				color: "#ffffff",
				transform: `rotate(${rotation})`,
				pointerEvents: "auto",
				touchAction: "none",
				userSelect: "none",
				webkitUserSelect: "none",
			} satisfies Partial<CSSStyleDeclaration>);
			btn.innerHTML = ARROW_SVG;

			this.bindButton(btn, {
				onPress: () => this.touchManager.setDPad(direction, true),
				onRelease: () => this.touchManager.setDPad(direction, false),
				activeColor: "rgba(255, 255, 255, 0.35)",
				inactiveColor: "rgba(255, 255, 255, 0.12)",
			});

			if (direction === "up") this.dpadUp = btn;
			if (direction === "down") this.dpadDown = btn;

			container.appendChild(btn);
		}

		return container;
	}

	// --- Action Buttons ---

	private createActionButtons(): HTMLDivElement {
		const container = document.createElement("div");
		container.id = "action-buttons";
		Object.assign(container.style, {
			position: "absolute",
			bottom: "calc(28px + env(safe-area-inset-bottom, 0px))",
			right: "calc(16px + env(safe-area-inset-right, 0px))",
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			gap: "12px",
			pointerEvents: "none",
		} satisfies Partial<CSSStyleDeclaration>);

		// Autopilot button
		const autopilot = document.createElement("div");
		autopilot.id = "touch-autopilot";
		Object.assign(autopilot.style, {
			width: "48px",
			height: "48px",
			borderRadius: "50%",
			backgroundColor: "rgba(100, 100, 100, 0.35)",
			border: "1px solid rgba(255, 255, 255, 0.2)",
			display: "none", // hidden until oil_tanker assigned
			alignItems: "center",
			justifyContent: "center",
			color: "#999999",
			fontFamily: "monospace",
			fontWeight: "bold",
			fontSize: "14px",
			pointerEvents: "auto",
			touchAction: "none",
			userSelect: "none",
			webkitUserSelect: "none",
		} satisfies Partial<CSSStyleDeclaration>);
		autopilot.textContent = "AP";

		// Autopilot is a toggle, not hold
		autopilot.addEventListener(
			"touchstart",
			(e) => {
				e.preventDefault();
				this.tryFullscreen();
				this.touchManager.toggleAutopilot();
			},
			{ passive: false },
		);

		// Camera toggle button
		const camera = document.createElement("div");
		camera.id = "touch-camera";
		Object.assign(camera.style, {
			width: "44px",
			height: "44px",
			borderRadius: "50%",
			backgroundColor: "rgba(100, 100, 100, 0.35)",
			border: "1px solid rgba(255, 255, 255, 0.2)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			color: "#bbbbbb",
			fontFamily: "monospace",
			fontWeight: "bold",
			fontSize: "11px",
			pointerEvents: "auto",
			touchAction: "none",
			userSelect: "none",
			webkitUserSelect: "none",
		} satisfies Partial<CSSStyleDeclaration>);
		camera.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;

		// Camera is a toggle, not hold
		camera.addEventListener(
			"touchstart",
			(e) => {
				e.preventDefault();
				this.tryFullscreen();
				this.touchManager.cycleCameraMode();
			},
			{ passive: false },
		);

		container.append(camera, autopilot);
		return container;
	}

	// --- Respawn button ---

	private createRespawnButton(): HTMLDivElement {
		const btn = document.createElement("div");
		btn.id = "touch-respawn";
		Object.assign(btn.style, {
			position: "absolute",
			bottom: "50%",
			left: "50%",
			transform: "translate(-50%, 50%)",
			padding: "14px 32px",
			borderRadius: "8px",
			backgroundColor: "rgba(200, 60, 30, 0.55)",
			border: "2px solid rgba(255, 100, 60, 0.5)",
			display: "none",
			alignItems: "center",
			justifyContent: "center",
			color: "#ffffff",
			fontFamily: "monospace",
			fontWeight: "bold",
			fontSize: "18px",
			letterSpacing: "2px",
			pointerEvents: "auto",
			touchAction: "none",
			userSelect: "none",
			webkitUserSelect: "none",
		} satisfies Partial<CSSStyleDeclaration>);
		btn.textContent = "RESPAWN";

		this.bindButton(btn, {
			onPress: () => this.touchManager.setFire(true),
			onRelease: () => this.touchManager.setFire(false),
			activeColor: "rgba(255, 80, 40, 0.75)",
			inactiveColor: "rgba(200, 60, 30, 0.55)",
		});

		return btn;
	}

	// --- Touch event binding ---

	private bindButton(
		el: HTMLElement,
		opts: {
			onPress: () => void;
			onRelease: () => void;
			activeColor: string;
			inactiveColor: string;
		},
	): void {
		el.addEventListener(
			"touchstart",
			(e) => {
				e.preventDefault();
				this.tryFullscreen();
				const touch = e.changedTouches[0];
				this.activeTouches.set(el, touch.identifier);
				el.style.backgroundColor = opts.activeColor;
				opts.onPress();
			},
			{ passive: false },
		);

		const release = (e: TouchEvent) => {
			e.preventDefault();
			for (const touch of Array.from(e.changedTouches)) {
				if (this.activeTouches.get(el) === touch.identifier) {
					this.activeTouches.delete(el);
					el.style.backgroundColor = opts.inactiveColor;
					opts.onRelease();
					break;
				}
			}
		};

		el.addEventListener("touchend", release, { passive: false });
		el.addEventListener("touchcancel", release, { passive: false });
	}

	// --- Fullscreen ---

	private tryFullscreen(): void {
		if (this.requestedFullscreen) return;
		this.requestedFullscreen = true;
		const el = document.documentElement as HTMLElement & {
			webkitRequestFullscreen?: () => Promise<void>;
		};
		const fn = el.requestFullscreen ?? el.webkitRequestFullscreen;
		if (fn) {
			fn.call(el).catch(() => {
				/* fullscreen rejected — degrade gracefully */
			});
		}
	}
}
