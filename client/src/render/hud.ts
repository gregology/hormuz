/**
 * DOM-based HUD overlay — vehicle info, instruments, SITREP panel.
 *
 * Creates text lines and panels as plain HTML elements overlaid on
 * the Three.js canvas. Throttle bar and autopilot indicator for ships.
 */

import { MAX_HP, type VehicleType } from "../generated/vehicles";
import { toLatLon } from "../map/data";

export interface GameStats {
	totalUsd: number;
	tankersDelivered: number;
	tankersSunk: number;
	frigatesSunk: number;
	shahedsIntercepted: number;
	quadcoptersIntercepted: number;
	speedboatsSunk: number;
	playersOnline: number;
}

export interface VehicleInstruments {
	speed: number;
	heading: number;
	x: number;
	y: number;
	hp: number;
	maxHp: number;
	floodLevel: number;
	vehicleType: string;
	batteryPct: number;
}

function headingToCardinal(radians: number): string {
	// Game heading: 0 = east, PI/2 = south, PI = west, -PI/2 = north
	const deg = ((radians * 180) / Math.PI + 360) % 360;
	const dirs = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
	const idx = Math.round(deg / 45) % 8;
	return dirs[idx];
}

function headingToDegrees(radians: number): number {
	return Math.round(((radians * 180) / Math.PI + 360) % 360);
}

function hpBarColor(fraction: number): string {
	if (fraction > 0.6) return "#00cc44";
	if (fraction > 0.3) return "#ccaa00";
	return "#cc2200";
}

export class HUD {
	readonly root: HTMLDivElement;
	private vehicleEl: HTMLDivElement;
	private controlsEl: HTMLDivElement;
	private tipEl: HTMLDivElement;

	// Throttle bar
	private throttleContainer: HTMLDivElement;
	private throttleSegments: HTMLDivElement[] = [];
	private throttleLabel: HTMLDivElement;

	// Autopilot badge
	private autopilotBadge: HTMLDivElement;

	// Vehicle instruments (bottom-left)
	private instrumentsPanel: HTMLDivElement;
	private speedEl: HTMLDivElement;
	private headingEl: HTMLDivElement;
	private positionEl: HTMLDivElement;
	private hpBarOuter: HTMLDivElement;
	private hpBarFill: HTMLDivElement;
	private hpBarFlood: HTMLDivElement;
	private hpLabel: HTMLDivElement;

	// Battery bar (drones only)
	private batteryRow: HTMLDivElement;
	private batteryBarFill: HTMLDivElement;
	private batteryLabel: HTMLDivElement;
	private batteryIcon: HTMLDivElement;

	// SITREP panel (top-right)
	private sitrepPanel: HTMLDivElement;
	private sitrepLines: Record<string, HTMLDivElement> = {};

	private isMobile: boolean;

	constructor(parent: HTMLElement) {
		this.isMobile = navigator.maxTouchPoints > 0;
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
		this.controlsEl = document.createElement("div");
		Object.assign(this.controlsEl.style, {
			fontSize: "12px",
			color: "#88aa88",
			marginTop: "2px",
		} satisfies Partial<CSSStyleDeclaration>);
		this.tipEl = document.createElement("div");
		Object.assign(this.tipEl.style, {
			fontSize: "12px",
			color: "#aa9966",
			marginTop: "2px",
			fontStyle: "italic",
		} satisfies Partial<CSSStyleDeclaration>);
		this.root.append(this.vehicleEl, this.controlsEl, this.tipEl);
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

		// --- Vehicle instruments panel (bottom-left) ---
		const isMobile = navigator.maxTouchPoints > 0;
		this.instrumentsPanel = document.createElement("div");
		Object.assign(this.instrumentsPanel.style, {
			position: "absolute",
			bottom: isMobile ? "200px" : "20px",
			left: "16px",
			fontFamily: "monospace",
			fontSize: "13px",
			color: "#ccddcc",
			textShadow: "1px 1px 2px #000",
			pointerEvents: "none",
			display: "none",
			lineHeight: "18px",
		} satisfies Partial<CSSStyleDeclaration>);

		this.speedEl = document.createElement("div");
		this.headingEl = document.createElement("div");
		this.positionEl = document.createElement("div");

		// HP bar
		const hpRow = document.createElement("div");
		Object.assign(hpRow.style, {
			display: "flex",
			alignItems: "center",
			gap: "6px",
			marginTop: "4px",
		} satisfies Partial<CSSStyleDeclaration>);

		this.hpLabel = document.createElement("div");
		this.hpLabel.style.minWidth = "24px";

		this.hpBarOuter = document.createElement("div");
		Object.assign(this.hpBarOuter.style, {
			width: "120px",
			height: "10px",
			backgroundColor: "#222",
			border: "1px solid #555",
			borderRadius: "2px",
			position: "relative",
			overflow: "hidden",
		} satisfies Partial<CSSStyleDeclaration>);

		this.hpBarFill = document.createElement("div");
		Object.assign(this.hpBarFill.style, {
			height: "100%",
			backgroundColor: "#00cc44",
			position: "absolute",
			top: "0",
			left: "0",
			transition: "width 0.15s, background-color 0.3s",
		} satisfies Partial<CSSStyleDeclaration>);

		this.hpBarFlood = document.createElement("div");
		Object.assign(this.hpBarFlood.style, {
			height: "100%",
			backgroundColor: "rgba(30, 100, 200, 0.6)",
			position: "absolute",
			top: "0",
			right: "0",
			transition: "width 0.3s",
			width: "0%",
		} satisfies Partial<CSSStyleDeclaration>);

		this.hpBarOuter.append(this.hpBarFill, this.hpBarFlood);
		hpRow.append(this.hpLabel, this.hpBarOuter);

		// Battery bar
		this.batteryRow = document.createElement("div");
		Object.assign(this.batteryRow.style, {
			display: "none",
			alignItems: "center",
			gap: "6px",
			marginTop: "4px",
		} satisfies Partial<CSSStyleDeclaration>);

		this.batteryLabel = document.createElement("div");
		this.batteryLabel.style.minWidth = "24px";

		const batteryBarOuter = document.createElement("div");
		Object.assign(batteryBarOuter.style, {
			width: "120px",
			height: "10px",
			backgroundColor: "#222",
			border: "1px solid #555",
			borderRadius: "2px",
			position: "relative",
			overflow: "hidden",
		} satisfies Partial<CSSStyleDeclaration>);

		this.batteryBarFill = document.createElement("div");
		Object.assign(this.batteryBarFill.style, {
			height: "100%",
			backgroundColor: "#00aaff",
			position: "absolute",
			top: "0",
			left: "0",
			transition: "width 0.15s, background-color 0.3s",
		} satisfies Partial<CSSStyleDeclaration>);

		batteryBarOuter.append(this.batteryBarFill);

		this.batteryIcon = document.createElement("div");
		this.batteryIcon.textContent = "BATT";
		Object.assign(this.batteryIcon.style, {
			fontSize: "10px",
			color: "#668899",
		} satisfies Partial<CSSStyleDeclaration>);

		this.batteryRow.append(
			this.batteryLabel,
			batteryBarOuter,
			this.batteryIcon,
		);

		this.instrumentsPanel.append(
			this.speedEl,
			this.headingEl,
			this.positionEl,
			hpRow,
			this.batteryRow,
		);
		parent.appendChild(this.instrumentsPanel);

		// --- SITREP panel (top-right) ---
		this.sitrepPanel = document.createElement("div");
		Object.assign(this.sitrepPanel.style, {
			position: "absolute",
			top: "12px",
			right: "16px",
			fontFamily: "monospace",
			fontSize: "12px",
			color: "#99bb99",
			textShadow: "1px 1px 2px #000",
			backgroundColor: "rgba(0, 0, 0, 0.45)",
			padding: "8px 12px",
			borderRadius: "4px",
			border: "1px solid rgba(100, 140, 100, 0.3)",
			pointerEvents: "none",
			lineHeight: "17px",
			minWidth: "220px",
		} satisfies Partial<CSSStyleDeclaration>);

		const sitrepTitle = document.createElement("div");
		Object.assign(sitrepTitle.style, {
			color: "#bbddbb",
			fontWeight: "bold",
			fontSize: "11px",
			marginBottom: "4px",
			letterSpacing: "1px",
		} satisfies Partial<CSSStyleDeclaration>);
		sitrepTitle.textContent = "SITUATION REPORT";
		this.sitrepPanel.appendChild(sitrepTitle);

		const statKeys = [
			"straitTime",
			"tankersTransited",
			"tankersSunk",
			"frigatesSunk",
			"shahedsIntercepted",
			"quadcoptersIntercepted",
			"speedboatsSunk",
			"warCost",
			"playersOnline",
		];
		for (const key of statKeys) {
			const line = document.createElement("div");
			this.sitrepLines[key] = line;
			this.sitrepPanel.appendChild(line);
		}

		parent.appendChild(this.sitrepPanel);
	}

	/**
	 * @param look Third-person look-around state: "available" before the
	 *   mouse is captured, "active" while it is.
	 */
	updateVehicle(
		spectating: boolean,
		hasPendingAssign: boolean,
		vehicleType: string,
		look: "none" | "available" | "active" = "none",
	): void {
		const typeLabel =
			vehicleType === "oil_tanker"
				? "Oil Tanker"
				: vehicleType === "shahed"
					? "Shahed Drone"
					: vehicleType === "frigate"
						? "Frigate"
						: vehicleType === "quadcopter"
							? "Quadcopter"
							: vehicleType || "Spectating";

		if (spectating) {
			this.vehicleEl.textContent = hasPendingAssign
				? this.isMobile
					? "Destroyed -- tap RESPAWN"
					: "Destroyed -- press SPACE to respawn  |  scroll to zoom"
				: "Destroyed -- waiting for vehicle...";
			this.controlsEl.textContent = this.isMobile
				? ""
				: "arrows pan  |  scroll zoom";
			this.tipEl.textContent = "";
		} else {
			if (this.isMobile) {
				this.vehicleEl.textContent = `You: ${typeLabel}`;
				this.controlsEl.textContent =
					look === "none" ? "" : "drag to look around";
			} else {
				const controlHint =
					vehicleType === "oil_tanker"
						? "arrows to steer/throttle  |  P autopilot"
						: vehicleType === "frigate" || vehicleType === "speedboat"
							? "arrows to steer/throttle"
							: "arrows to move";
				this.vehicleEl.textContent = `You: ${typeLabel}  |  ${controlHint}`;
				this.controlsEl.textContent =
					look === "available"
						? "V camera  |  click to look around  |  scroll zoom"
						: look === "active"
							? "V camera  |  mouse to look  |  Esc frees the cursor  |  scroll zoom"
							: "V camera  |  scroll zoom";
			}

			const TIPS: Partial<Record<string, string>> = {
				shahed: this.isMobile
					? "Frigates jam shaheds — you'll lose steering near them"
					: "Tip: Frigates jam shaheds — you'll lose steering if you fly too close",
			};
			this.tipEl.textContent = TIPS[vehicleType] ?? "";
		}
	}

	updateInstruments(instruments: VehicleInstruments | null): void {
		if (!instruments) {
			this.instrumentsPanel.style.display = "none";
			return;
		}
		this.instrumentsPanel.style.display = "block";

		const {
			speed,
			heading,
			x,
			y,
			hp,
			maxHp,
			floodLevel,
			vehicleType,
			batteryPct,
		} = instruments;

		// Speed — show equilibrium speed label based on vehicle type
		const spd = Math.abs(speed).toFixed(1);
		this.speedEl.textContent = `SPD  ${spd}`;

		// Heading
		const deg = headingToDegrees(heading);
		const cardinal = headingToCardinal(heading);
		this.headingEl.textContent = `HDG  ${String(deg).padStart(3, "0")}° ${cardinal}`;

		// Position (lat/lon)
		const [lat, lon] = toLatLon(x, y);
		const latDir = lat >= 0 ? "N" : "S";
		const lonDir = lon >= 0 ? "E" : "W";
		this.positionEl.textContent = `POS  ${Math.abs(lat).toFixed(4)}°${latDir}  ${Math.abs(lon).toFixed(4)}°${lonDir}`;

		// HP bar
		const effectiveMax = maxHp || MAX_HP[vehicleType as VehicleType] || 100;
		const fraction = Math.max(0, hp / effectiveMax);
		this.hpBarFill.style.width = `${fraction * 100}%`;
		this.hpBarFill.style.backgroundColor = hpBarColor(fraction);
		this.hpLabel.textContent = `${hp}`;

		// Flood overlay (ships only)
		if (floodLevel > 0) {
			this.hpBarFlood.style.width = `${floodLevel * 100}%`;
		} else {
			this.hpBarFlood.style.width = "0%";
		}

		// Battery/fuel bar (drones only — batteryPct >= 0 means entity has a battery/fuel)
		if (batteryPct >= 0) {
			this.batteryRow.style.display = "flex";
			this.batteryIcon.textContent = vehicleType === "shahed" ? "FUEL" : "BATT";
			const pct = Math.max(0, Math.min(100, batteryPct));
			this.batteryBarFill.style.width = `${pct}%`;
			this.batteryBarFill.style.backgroundColor =
				pct > 40 ? "#00aaff" : pct > 15 ? "#ffaa00" : "#ff3300";
			this.batteryLabel.textContent = `${Math.round(pct)}%`;
		} else {
			this.batteryRow.style.display = "none";
		}
	}

	updateStats(stats: GameStats): void {
		const fmt = (n: number) => String(n).padStart(4);

		this.sitrepLines.tankersTransited.textContent = `Tankers Transited  ${fmt(stats.tankersDelivered)}`;
		this.sitrepLines.tankersSunk.textContent = `Tankers Sunk       ${fmt(stats.tankersSunk)}`;
		this.sitrepLines.frigatesSunk.textContent = `Frigates Sunk      ${fmt(stats.frigatesSunk)}`;
		this.sitrepLines.shahedsIntercepted.textContent = `Shaheds Shot Down  ${fmt(stats.shahedsIntercepted)}`;
		this.sitrepLines.quadcoptersIntercepted.textContent = `Quads Shot Down    ${fmt(stats.quadcoptersIntercepted)}`;
		this.sitrepLines.speedboatsSunk.textContent = `Speedboats Sunk    ${fmt(stats.speedboatsSunk)}`;

		const costStr = stats.totalUsd.toLocaleString("en-US", {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 0,
		});
		this.sitrepLines.warCost.textContent = `War Cost     ${costStr}`;

		this.sitrepLines.playersOnline.textContent = `Players Online     ${fmt(stats.playersOnline)}`;
	}

	/** Local time in the strait (the game's lighting follows it). */
	updateClock(straitTime: string): void {
		this.sitrepLines.straitTime.textContent = `Strait Time   ${straitTime} GST`;
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
