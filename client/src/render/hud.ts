/**
 * DOM-based HUD overlay — replaces PixiJS Text elements.
 *
 * Creates three text lines (vehicle info, war cost, status) as plain
 * HTML elements styled to match the previous PixiJS HUD.
 */

export class HUD {
	readonly root: HTMLDivElement;
	private vehicleEl: HTMLDivElement;
	private costEl: HTMLDivElement;
	private statusEl: HTMLDivElement;

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
			this.vehicleEl.textContent = `You: ${typeLabel}  |  WASD to control`;
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
}
