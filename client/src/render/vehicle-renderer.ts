/**
 * Isometric vehicle renderer with 3D extruded shapes.
 *
 * Each vehicle is built from stacked "blocks" — polygon outlines extruded
 * vertically. Visible side faces are shaded darker than the top face,
 * giving the classic isometric pixel-art depth look.
 *
 * Height goes straight up on screen (negative screen Y).
 * Visible sides are those facing south (screen Y+) or east (screen X+).
 */

import type { Graphics } from "pixi.js";
import { getElevation, getSlopeAlongHeading } from "../map/heightmap";
import type { NavalVehicle, VehicleType } from "../vehicles/physics";
import { type Camera, worldToScreen } from "./camera";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LP = [number, number]; // local-space point [forward, starboard]

interface Block {
	outline: LP[];
	baseHeight: number; // fraction of vehicle size (0 = waterline)
	topHeight: number;
	/** If set, overrides faction color for the top face */
	topColor?: number;
	topAlpha?: number;
	sideAlpha?: number;
}

interface FlatDetail {
	kind: "line" | "circle";
	height: number; // drawn at this height fraction
	// Line
	x1?: number;
	y1?: number;
	x2?: number;
	y2?: number;
	// Circle
	cx?: number;
	cy?: number;
	r?: number;
	color: number;
	width?: number;
	alpha: number;
}

interface VehicleModel {
	blocks: Block[];
	details: FlatDetail[];
}

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

function darken(color: number, factor: number): number {
	const r = ((color >> 16) & 0xff) * factor;
	const g = ((color >> 8) & 0xff) * factor;
	const b = (color & 0xff) * factor;
	return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

// ---------------------------------------------------------------------------
// Projection with height
// ---------------------------------------------------------------------------

/** Project a local-space point at a given height to screen coordinates. */
function toScreen(
	cam: Camera,
	vx: number,
	vy: number,
	cos: number,
	sin: number,
	size: number,
	lx: number,
	ly: number,
	heightFraction: number,
	terrainElevation = 0,
	pitchSlope = 0,
): { x: number; y: number } {
	const wx = vx + (lx * cos - ly * sin) * size;
	const wy = vy + (lx * sin + ly * cos) * size;
	const s = worldToScreen(cam, wx, wy);
	// Height: vehicle block height + terrain elevation + pitch from slope
	// pitchSlope tilts fore/aft vertices based on their forward offset (lx)
	s.y -=
		((heightFraction + lx * pitchSlope) * size + terrainElevation) * cam.zoom;
	return s;
}

// ---------------------------------------------------------------------------
// 3D block rendering
// ---------------------------------------------------------------------------

/**
 * Draw an extruded block: visible side faces + top face.
 *
 * Side face visibility: for each edge A→B (clockwise winding in screen space),
 * the outward normal is (By-Ay, Ax-Bx). A side is visible if it faces
 * toward the camera — normal.y > 0 (south-facing) or normal.x > 0 (east-facing).
 */
function drawBlock(
	g: Graphics,
	cam: Camera,
	vehicle: NavalVehicle,
	cos: number,
	sin: number,
	block: Block,
	factionColor: number,
	terrainElevation = 0,
	pitchSlope = 0,
) {
	const { outline, baseHeight, topHeight } = block;
	const n = outline.length;
	if (n < 3) return;

	const size = vehicle.size;
	const topAlpha = block.topAlpha ?? 1;
	const sideAlpha = block.sideAlpha ?? 1;

	// Pre-compute screen positions for top and bottom of each vertex
	const topPts: { x: number; y: number }[] = [];
	const botPts: { x: number; y: number }[] = [];
	for (let i = 0; i < n; i++) {
		topPts.push(
			toScreen(
				cam,
				vehicle.x,
				vehicle.y,
				cos,
				sin,
				size,
				outline[i][0],
				outline[i][1],
				topHeight,
				terrainElevation,
				pitchSlope,
			),
		);
		botPts.push(
			toScreen(
				cam,
				vehicle.x,
				vehicle.y,
				cos,
				sin,
				size,
				outline[i][0],
				outline[i][1],
				baseHeight,
				terrainElevation,
				pitchSlope,
			),
		);
	}

	const southColor = darken(factionColor, 0.45);
	const eastColor = darken(factionColor, 0.65);

	// Draw visible side faces
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const at = topPts[i],
			bt = topPts[j];
		const ab = botPts[i],
			bb = botPts[j];

		// Outward normal for clockwise winding: (By-Ay, Ax-Bx)
		const nx = bt.y - at.y;
		const ny = at.x - bt.x;

		if (ny > 0 || nx > 0) {
			// Shade: south-dominant vs east-dominant
			const sideColor = ny > Math.abs(nx) ? southColor : eastColor;

			g.moveTo(at.x, at.y);
			g.lineTo(bt.x, bt.y);
			g.lineTo(bb.x, bb.y);
			g.lineTo(ab.x, ab.y);
			g.closePath();
			g.fill({ color: sideColor, alpha: sideAlpha });
		}
	}

	// Draw top face
	const topColor = block.topColor ?? factionColor;
	g.moveTo(topPts[0].x, topPts[0].y);
	for (let i = 1; i < n; i++) {
		g.lineTo(topPts[i].x, topPts[i].y);
	}
	g.closePath();
	g.fill({ color: topColor, alpha: topAlpha });

	// Subtle top edge outline
	g.moveTo(topPts[0].x, topPts[0].y);
	for (let i = 1; i < n; i++) {
		g.lineTo(topPts[i].x, topPts[i].y);
	}
	g.closePath();
	g.stroke({ color: 0x000000, width: 1, alpha: 0.25 });
}

// ---------------------------------------------------------------------------
// Flat detail rendering (lines and circles at a given height)
// ---------------------------------------------------------------------------

function drawDetail(
	g: Graphics,
	cam: Camera,
	vehicle: NavalVehicle,
	cos: number,
	sin: number,
	detail: FlatDetail,
	terrainElevation = 0,
	pitchSlope = 0,
) {
	const s = vehicle.size;
	if (detail.kind === "line") {
		const a = toScreen(
			cam,
			vehicle.x,
			vehicle.y,
			cos,
			sin,
			s,
			detail.x1!,
			detail.y1!,
			detail.height,
			terrainElevation,
			pitchSlope,
		);
		const b = toScreen(
			cam,
			vehicle.x,
			vehicle.y,
			cos,
			sin,
			s,
			detail.x2!,
			detail.y2!,
			detail.height,
			terrainElevation,
			pitchSlope,
		);
		g.moveTo(a.x, a.y);
		g.lineTo(b.x, b.y);
		g.stroke({
			color: detail.color,
			width: detail.width ?? 1,
			alpha: detail.alpha,
		});
	} else {
		const c = toScreen(
			cam,
			vehicle.x,
			vehicle.y,
			cos,
			sin,
			s,
			detail.cx!,
			detail.cy!,
			detail.height,
			terrainElevation,
			pitchSlope,
		);
		const r = detail.r! * s * cam.zoom;
		g.circle(c.x, c.y, r);
		g.fill({ color: detail.color, alpha: detail.alpha });
	}
}

// ---------------------------------------------------------------------------
// Wake
// ---------------------------------------------------------------------------

function drawWake(
	g: Graphics,
	cam: Camera,
	vehicle: NavalVehicle,
	cos: number,
	sin: number,
) {
	if (Math.abs(vehicle.speed) < 0.3) return;

	const intensity = Math.min(Math.abs(vehicle.speed) / vehicle.maxSpeed, 1);
	const s = vehicle.size;
	const wakeLen = s * (0.4 + 0.8 * intensity);
	const halfBeam = s * 0.1;

	const sternX = vehicle.x - cos * s * 0.45;
	const sternY = vehicle.y - sin * s * 0.45;

	for (let side = -1; side <= 1; side += 2) {
		const px = -sin * side;
		const py = cos * side;

		const start = worldToScreen(
			cam,
			sternX + px * halfBeam,
			sternY + py * halfBeam,
		);
		const end = worldToScreen(
			cam,
			sternX - cos * wakeLen + px * halfBeam * (2.5 + intensity),
			sternY - sin * wakeLen + py * halfBeam * (2.5 + intensity),
		);
		g.moveTo(start.x, start.y);
		g.lineTo(end.x, end.y);
	}
	g.stroke({ color: 0xffffff, width: 1.2, alpha: 0.2 * intensity });

	// Center foam
	const cs = worldToScreen(cam, sternX, sternY);
	const ce = worldToScreen(
		cam,
		sternX - cos * wakeLen * 0.5,
		sternY - sin * wakeLen * 0.5,
	);
	g.moveTo(cs.x, cs.y);
	g.lineTo(ce.x, ce.y);
	g.stroke({ color: 0xffffff, width: 0.8, alpha: 0.12 * intensity });
}

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

const STEEL = 0x8899aa;
const GLASS = 0xaaddff;
const DECK_GREY = 0x667788;
const GUN_METAL = 0x445566;
const PIPE = 0x887766;

function speedboatModel(): VehicleModel {
	const hull: LP[] = [
		[0.5, 0],
		[0.3, -0.1],
		[0.05, -0.13],
		[-0.3, -0.14],
		[-0.4, -0.1],
		[-0.42, -0.04],
		[-0.42, 0.04],
		[-0.4, 0.1],
		[-0.3, 0.14],
		[0.05, 0.13],
		[0.3, 0.1],
	];

	const cockpit: LP[] = [
		[0.12, -0.06],
		[-0.12, -0.07],
		[-0.15, -0.04],
		[-0.15, 0.04],
		[-0.12, 0.07],
		[0.12, 0.06],
	];

	return {
		blocks: [
			// Hull (waterline to deck)
			{ outline: hull, baseHeight: 0, topHeight: 0.35 },
			// Cockpit / centre console (raised)
			{
				outline: cockpit,
				baseHeight: 0.35,
				topHeight: 0.55,
				topColor: DECK_GREY,
				topAlpha: 0.9,
			},
		],
		details: [
			// Windscreen
			{
				kind: "line",
				height: 0.55,
				x1: 0.12,
				y1: -0.055,
				x2: 0.12,
				y2: 0.055,
				color: GLASS,
				width: 1.5,
				alpha: 0.8,
			},
			// Engine
			{
				kind: "circle",
				height: 0.3,
				cx: -0.42,
				cy: 0,
				r: 0.03,
				color: GUN_METAL,
				alpha: 0.7,
			},
		],
	};
}

function frigateModel(): VehicleModel {
	const hull: LP[] = [
		[0.5, 0], // bow
		[0.42, -0.04],
		[0.3, -0.065],
		[0.15, -0.075],
		[0.0, -0.08],
		[-0.2, -0.08],
		[-0.35, -0.07],
		[-0.42, -0.055],
		[-0.45, -0.03],
		[-0.45, 0.03],
		[-0.42, 0.055],
		[-0.35, 0.07],
		[-0.2, 0.08],
		[0.0, 0.08],
		[0.15, 0.075],
		[0.3, 0.065],
		[0.42, 0.04],
	];

	const superstructure: LP[] = [
		[-0.02, -0.048],
		[-0.22, -0.048],
		[-0.24, -0.035],
		[-0.24, 0.035],
		[-0.22, 0.048],
		[-0.02, 0.048],
		[0.0, 0.035],
		[0.0, -0.035],
	];

	const forwardTurret: LP[] = [
		[0.32, -0.02],
		[0.25, -0.025],
		[0.25, 0.025],
		[0.32, 0.02],
	];

	const helipad: LP[] = [
		[-0.28, -0.045],
		[-0.4, -0.045],
		[-0.42, -0.03],
		[-0.42, 0.03],
		[-0.4, 0.045],
		[-0.28, 0.045],
	];

	return {
		blocks: [
			// Hull
			{ outline: hull, baseHeight: 0, topHeight: 0.14 },
			// Helipad (slightly raised aft deck)
			{
				outline: helipad,
				baseHeight: 0.14,
				topHeight: 0.16,
				topColor: DECK_GREY,
			},
			// Forward turret base
			{
				outline: forwardTurret,
				baseHeight: 0.14,
				topHeight: 0.2,
				topColor: GUN_METAL,
			},
			// Main superstructure / bridge
			{
				outline: superstructure,
				baseHeight: 0.14,
				topHeight: 0.35,
				topColor: STEEL,
			},
		],
		details: [
			// Bridge windows
			{
				kind: "line",
				height: 0.35,
				x1: -0.02,
				y1: -0.035,
				x2: -0.02,
				y2: 0.035,
				color: GLASS,
				width: 2,
				alpha: 0.7,
			},
			// Gun barrel
			{
				kind: "line",
				height: 0.22,
				x1: 0.32,
				y1: 0,
				x2: 0.44,
				y2: 0,
				color: GUN_METAL,
				width: 2,
				alpha: 0.8,
			},
			// Mast
			{
				kind: "circle",
				height: 0.5,
				cx: -0.1,
				cy: 0,
				r: 0.008,
				color: STEEL,
				alpha: 0.8,
			},
			// Radar dome
			{
				kind: "circle",
				height: 0.5,
				cx: -0.12,
				cy: 0,
				r: 0.006,
				color: 0xffffff,
				alpha: 0.5,
			},
			// CIWS aft
			{
				kind: "circle",
				height: 0.18,
				cx: -0.26,
				cy: 0,
				r: 0.012,
				color: GUN_METAL,
				alpha: 0.7,
			},
			// Helipad circle
			{
				kind: "circle",
				height: 0.16,
				cx: -0.35,
				cy: 0,
				r: 0.025,
				color: 0xffffff,
				alpha: 0.15,
			},
		],
	};
}

function oilTankerModel(): VehicleModel {
	const hull: LP[] = [
		[0.48, -0.02],
		[0.5, 0],
		[0.48, 0.02],
		[0.44, -0.06],
		[0.38, -0.085],
		[0.25, -0.09],
		[-0.3, -0.09],
		[-0.4, -0.085],
		[-0.44, -0.07],
		[-0.46, -0.04],
		[-0.46, 0.04],
		[-0.44, 0.07],
		[-0.4, 0.085],
		[-0.3, 0.09],
		[0.25, 0.09],
		[0.38, 0.085],
		[0.44, 0.06],
	];

	const forecastle: LP[] = [
		[0.46, -0.03],
		[0.38, -0.07],
		[0.28, -0.075],
		[0.28, 0.075],
		[0.38, 0.07],
		[0.46, 0.03],
	];

	const bridge: LP[] = [
		[-0.3, -0.058],
		[-0.42, -0.058],
		[-0.44, -0.04],
		[-0.44, 0.04],
		[-0.42, 0.058],
		[-0.3, 0.058],
	];

	const funnel: LP[] = [
		[-0.37, -0.02],
		[-0.41, -0.02],
		[-0.41, 0.02],
		[-0.37, 0.02],
	];

	// Cargo tank section outlines (drawn as shallow raised blocks)
	const tanks: Block[] = [];
	const tankCount = 5;
	const tankX1 = -0.25;
	const tankX2 = 0.26;
	const tankW = (tankX2 - tankX1) / tankCount;
	const gap = tankW * 0.06;

	for (let i = 0; i < tankCount; i++) {
		const x1 = tankX1 + i * tankW + gap;
		const x2 = tankX1 + (i + 1) * tankW - gap;
		// Port tank
		tanks.push({
			outline: [
				[x1, -0.07],
				[x2, -0.07],
				[x2, -0.01],
				[x1, -0.01],
			],
			baseHeight: 0.1,
			topHeight: 0.12,
			topColor: darken(DECK_GREY, 0.7),
			topAlpha: 0.6,
			sideAlpha: 0.4,
		});
		// Starboard tank
		tanks.push({
			outline: [
				[x1, 0.01],
				[x2, 0.01],
				[x2, 0.07],
				[x1, 0.07],
			],
			baseHeight: 0.1,
			topHeight: 0.12,
			topColor: darken(DECK_GREY, 0.7),
			topAlpha: 0.6,
			sideAlpha: 0.4,
		});
	}

	return {
		blocks: [
			// Hull
			{ outline: hull, baseHeight: 0, topHeight: 0.1 },
			// Forecastle (raised bow)
			{
				outline: forecastle,
				baseHeight: 0.1,
				topHeight: 0.16,
				topColor: STEEL,
				topAlpha: 0.8,
			},
			// Cargo tanks
			...tanks,
			// Bridge / accommodation block
			{ outline: bridge, baseHeight: 0.1, topHeight: 0.3, topColor: STEEL },
			// Funnel
			{ outline: funnel, baseHeight: 0.3, topHeight: 0.4, topColor: 0x333333 },
		],
		details: [
			// Bridge windows
			{
				kind: "line",
				height: 0.3,
				x1: -0.3,
				y1: -0.045,
				x2: -0.3,
				y2: 0.045,
				color: GLASS,
				width: 2.5,
				alpha: 0.7,
			},
			// Central pipe run
			{
				kind: "line",
				height: 0.12,
				x1: 0.26,
				y1: 0,
				x2: -0.25,
				y2: 0,
				color: PIPE,
				width: 2,
				alpha: 0.5,
			},
			// Bow mast
			{
				kind: "circle",
				height: 0.28,
				cx: 0.42,
				cy: 0,
				r: 0.006,
				color: STEEL,
				alpha: 0.6,
			},
			// Funnel top (dark opening)
			{
				kind: "circle",
				height: 0.4,
				cx: -0.39,
				cy: 0,
				r: 0.012,
				color: 0x111111,
				alpha: 0.8,
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Model cache
// ---------------------------------------------------------------------------

const modelCache = new Map<VehicleType, VehicleModel>();

function getModel(type: VehicleType): VehicleModel {
	let model = modelCache.get(type);
	if (!model) {
		switch (type) {
			case "speedboat":
				model = speedboatModel();
				break;
			case "frigate":
				model = frigateModel();
				break;
			case "oil_tanker":
				model = oilTankerModel();
				break;
		}
		modelCache.set(type, model);
	}
	return model;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderVehicle(
	g: Graphics,
	cam: Camera,
	vehicle: NavalVehicle,
	color: number,
) {
	const cos = Math.cos(vehicle.heading);
	const sin = Math.sin(vehicle.heading);

	// Terrain elevation and pitch at vehicle position
	const terrainElevation = getElevation(vehicle.x, vehicle.y);
	const pitchSlope = getSlopeAlongHeading(
		vehicle.x,
		vehicle.y,
		vehicle.heading,
	);

	// Wake (behind everything — drawn at water level, not terrain height)
	drawWake(g, cam, vehicle, cos, sin);

	// 3D blocks (elevated + pitched)
	const model = getModel(vehicle.vehicleType);
	for (const block of model.blocks) {
		drawBlock(
			g,
			cam,
			vehicle,
			cos,
			sin,
			block,
			color,
			terrainElevation,
			pitchSlope,
		);
	}

	// Flat details (elevated + pitched)
	for (const detail of model.details) {
		drawDetail(g, cam, vehicle, cos, sin, detail, terrainElevation, pitchSlope);
	}
}
