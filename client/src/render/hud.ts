/**
 * DOM-based HUD overlay — replaces PixiJS Text elements.
 *
 * Creates text lines (vehicle info, war cost, status) as plain
 * HTML elements, plus a throttle bar and autopilot indicator for ships.
 */

export class HUD {
	readonly root: HTMLDivElement;
	private vehicleEl: HTMLDivElement;
	private costEl: HTMLDivElement;
	private statusEl: HTMLDivElement;

	// Throttle bar
	private throttleContainer: HTMLDivElement;
	private throttleSegments: HTMLDivElement[] = [];
	private throttleLabel: HTMLDivElement;

	// Autopilot badge
	private autopilotBadge: HTMLDivElement;

	constructor(parent: HTMLElement) {
		this.root = document.createElement("div");
		this.root.id = "hud";
		Object.assign(this.root.style, {
			position: "absolute",
			top: "0",
			left: "0",
			pointerEvents: "none",
			padding: "10px",
			fontFamily: "monospace",
			fontSize: "14px",
			color: "#ffffff",
			textShadow: "1px 1px 2px #000000",
			lineHeight: "20px",
		} satisfies Partial<CSSStyleDeclaration>);

		this.vehicleEl = document.createElement("div");
		this.costEl = document.createElement("div");
		this.statusEl = document.createElement("div");
		this.statusEl.textContent = "Connecting...";

		this.root.append(this.vehicleEl, this.costEl, this.statusEl);
		parent.appendChild(this.root);

		// --- Throttle bar (right edge, vertical) ---
		this.throttleContainer = document.createElement("div");
		Object.assign(this.throttleContainer.style, {
			position: "absolute",
			right: "20px",
			top: "50%",
			transform: "translateY(-50%)",
			display: "none",
			flexDirection: "column",
			alignItems: "center",
			gap: "1px",
			pointerEvents: "none",
		} satisfies Partial<CSSStyleDeclaration>);

		// 21 segments: index 0 = +10 (top), index 10 = 0 (center), index 20 = -10 (bottom)
		for (let i = 0; i < 21; i++) {
			const level = 10 - i;
			const seg = document.createElement("div");
			Object.assign(seg.style, {
				width: "8px",
				height: level === 0 ? "3px" : "10px",
				backgroundColor: level === 0 ? "#ffffff" : "#333333",
				borderRadius: "1px",
			} satisfies Partial<CSSStyleDeclaration>);
			if (level !== 0) {
				seg.style.border = "1px solid #555";
			}
			this.throttleContainer.appendChild(seg);
			this.throttleSegments.push(seg);
		}

		this.throttleLabel = document.createElement("div");
		Object.assign(this.throttleLabel.style, {
			color: "#ffffff",
			fontFamily: "monospace",
			fontSize: "12px",
			marginTop: "4px",
			textShadow: "1px 1px 2px #000",
		} satisfies Partial<CSSStyleDeclaration>);
		this.throttleLabel.textContent = "0";
		this.throttleContainer.appendChild(this.throttleLabel);

		parent.appendChild(this.throttleContainer);

		// --- Autopilot badge ---
		this.autopilotBadge = document.createElement("div");
		Object.assign(this.autopilotBadge.style, {
			position: "absolute",
			right: "48px",
			top: "50%",
			transform: "translateY(-50%)",
			fontFamily: "monospace",
			fontSize: "16px",
			fontWeight: "bold",
			padding: "4px 8px",
			borderRadius: "4px",
			pointerEvents: "none",
			display: "none",
			textShadow: "1px 1px 2px #000",
		} satisfies Partial<CSSStyleDeclaration>);
		this.autopilotBadge.textContent = "AP";
		parent.appendChild(this.autopilotBadge);
	}

	updateVehicle(
		spectating: boolean,
		hasPendingAssign: boolean,
		vehicleType: string,
	): void {
		if (spectating) {
			this.vehicleEl.textContent = hasPendingAssign
				? "Destroyed -- press SPACE to respawn  |  scroll to zoom"
				: "Destroyed -- waiting for vehicle...";
		} else {
			const typeLabel =
				vehicleType === "oil_tanker"
					? "Oil Tanker"
					: vehicleType === "shahed"
						? "Shahed Drone"
						: vehicleType || "Spectating";
			const controlHint =
				vehicleType === "oil_tanker"
					? "arrows to steer/throttle  |  P autopilot"
					: "WASD to control";
			this.vehicleEl.textContent = `You: ${typeLabel}  |  ${controlHint}`;
		}
	}

	updateCost(totalUsd: number, delivered: number, sunk: number): void {
		const costStr = totalUsd.toLocaleString("en-US", {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 0,
		});
		this.costEl.textContent = `War Cost: ${costStr}  |  Delivered: ${delivered}  Sunk: ${sunk}`;
	}

	updateStatus(entityCount: number, zoom: number): void {
		this.statusEl.textContent = `Entities: ${entityCount}  |  Zoom: ${zoom.toFixed(3)}  [scroll to zoom]`;
	}

	updateThrottle(throttleLevel: number, visible: boolean): void {
		this.throttleContainer.style.display = visible ? "flex" : "none";
		if (!visible) return;

		this.throttleLabel.textContent =
			throttleLevel > 0 ? `+${throttleLevel}` : `${throttleLevel}`;

		for (let i = 0; i < 21; i++) {
			const segLevel = 10 - i;
			const seg = this.throttleSegments[i];

			if (segLevel === 0) {
				// Center line — always white
				seg.style.backgroundColor = "#ffffff";
			} else if (
				throttleLevel > 0 &&
				segLevel > 0 &&
				segLevel <= throttleLevel
			) {
				seg.style.backgroundColor = "#00cc44";
			} else if (
				throttleLevel < 0 &&
				segLevel < 0 &&
				segLevel >= throttleLevel
			) {
				seg.style.backgroundColor = "#cc4400";
			} else {
				seg.style.backgroundColor = "#333333";
			}
		}
	}

	updateAutopilot(autopilotOn: boolean, visible: boolean): void {
		this.autopilotBadge.style.display = visible ? "block" : "none";
		if (!visible) return;

		this.autopilotBadge.style.backgroundColor = autopilotOn
			? "#00aa44"
			: "#555555";
		this.autopilotBadge.style.color = autopilotOn ? "#ffffff" : "#999999";
	}
}
