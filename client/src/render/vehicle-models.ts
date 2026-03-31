/**
 * Vehicle model definitions — pure geometry data shared between renderers.
 *
 * Each vehicle is built from stacked "blocks" (extruded polygons) and
 * "flat details" (decorative lines and circles). Heights are fractions
 * of the vehicle's size parameter.
 */

import type { VehicleType } from "../vehicles/physics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Local-space point [forward, starboard]. */
export type LP = [number, number];

export interface Block {
	outline: LP[];
	baseHeight: number; // fraction of vehicle size (0 = waterline)
	topHeight: number;
	/** If set, overrides faction color for the top face */
	topColor?: number;
	topAlpha?: number;
	sideAlpha?: number;
}

export interface FlatDetail {
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

export interface VehicleModel {
	blocks: Block[];
	details: FlatDetail[];
}

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

export function darken(color: number, factor: number): number {
	const r = ((color >> 16) & 0xff) * factor;
	const g = ((color >> 8) & 0xff) * factor;
	const b = (color & 0xff) * factor;
	return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

// ---------------------------------------------------------------------------
// Color constants
// ---------------------------------------------------------------------------

const STEEL = 0x8899aa;
const GLASS = 0xaaddff;
const DECK_GREY = 0x667788;
const GUN_METAL = 0x445566;
const PIPE = 0x887766;

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

function speedboatModel(): VehicleModel {
	const keel: LP[] = [
		[0.42, 0],
		[0.3, -0.02],
		[0.0, -0.04],
		[-0.2, -0.05],
		[-0.38, -0.03],
		[-0.38, 0.03],
		[-0.2, 0.05],
		[0.0, 0.04],
		[0.3, 0.02],
	];

	const hull: LP[] = [
		[0.5, 0],
		[0.38, -0.04],
		[0.2, -0.08],
		[0.0, -0.11],
		[-0.2, -0.13],
		[-0.3, -0.14],
		[-0.4, -0.1],
		[-0.42, -0.04],
		[-0.42, 0.04],
		[-0.4, 0.1],
		[-0.3, 0.14],
		[-0.2, 0.13],
		[0.0, 0.11],
		[0.2, 0.08],
		[0.38, 0.04],
	];

	const cockpit: LP[] = [
		[0.0, -0.06],
		[-0.15, -0.07],
		[-0.18, -0.04],
		[-0.18, 0.04],
		[-0.15, 0.07],
		[0.0, 0.06],
	];

	return {
		blocks: [
			{
				outline: keel,
				baseHeight: -0.15,
				topHeight: 0,
				topColor: darken(STEEL, 0.5),
				sideAlpha: 0.7,
			},
			{ outline: hull, baseHeight: 0, topHeight: 0.3 },
			{
				outline: cockpit,
				baseHeight: 0.3,
				topHeight: 0.5,
				topColor: DECK_GREY,
				topAlpha: 0.9,
			},
		],
		details: [
			{
				kind: "line",
				height: 0.5,
				x1: 0.0,
				y1: -0.055,
				x2: 0.0,
				y2: 0.055,
				color: GLASS,
				width: 1.5,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.25,
				cx: -0.42,
				cy: -0.03,
				r: 0.025,
				color: GUN_METAL,
				alpha: 0.7,
			},
			{
				kind: "circle",
				height: 0.25,
				cx: -0.42,
				cy: 0.03,
				r: 0.025,
				color: GUN_METAL,
				alpha: 0.7,
			},
		],
	};
}

function frigateModel(): VehicleModel {
	const keel: LP[] = [
		[0.42, 0],
		[0.3, -0.015],
		[0.1, -0.025],
		[-0.1, -0.035],
		[-0.3, -0.04],
		[-0.4, -0.025],
		[-0.4, 0.025],
		[-0.3, 0.04],
		[-0.1, 0.035],
		[0.1, 0.025],
		[0.3, 0.015],
	];

	const hull: LP[] = [
		[0.5, 0],
		[0.45, -0.015],
		[0.38, -0.03],
		[0.28, -0.045],
		[0.15, -0.06],
		[0.0, -0.07],
		[-0.15, -0.08],
		[-0.3, -0.08],
		[-0.4, -0.065],
		[-0.45, -0.04],
		[-0.45, 0.04],
		[-0.4, 0.065],
		[-0.3, 0.08],
		[-0.15, 0.08],
		[0.0, 0.07],
		[0.15, 0.06],
		[0.28, 0.045],
		[0.38, 0.03],
		[0.45, 0.015],
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
			{
				outline: keel,
				baseHeight: -0.08,
				topHeight: 0,
				topColor: darken(STEEL, 0.4),
				sideAlpha: 0.6,
			},
			{ outline: hull, baseHeight: 0, topHeight: 0.14 },
			{
				outline: helipad,
				baseHeight: 0.14,
				topHeight: 0.16,
				topColor: DECK_GREY,
			},
			{
				outline: forwardTurret,
				baseHeight: 0.14,
				topHeight: 0.2,
				topColor: GUN_METAL,
			},
			{
				outline: superstructure,
				baseHeight: 0.14,
				topHeight: 0.35,
				topColor: STEEL,
			},
		],
		details: [
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
			{
				kind: "circle",
				height: 0.5,
				cx: -0.1,
				cy: 0,
				r: 0.008,
				color: STEEL,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.5,
				cx: -0.12,
				cy: 0,
				r: 0.006,
				color: 0xffffff,
				alpha: 0.5,
			},
			{
				kind: "circle",
				height: 0.18,
				cx: -0.26,
				cy: 0,
				r: 0.012,
				color: GUN_METAL,
				alpha: 0.7,
			},
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
		[0.5, 0],
		[0.48, 0.02],
		[0.44, 0.06],
		[0.38, 0.085],
		[0.25, 0.09],
		[-0.3, 0.09],
		[-0.4, 0.085],
		[-0.44, 0.07],
		[-0.46, 0.04],
		[-0.46, -0.04],
		[-0.44, -0.07],
		[-0.4, -0.085],
		[-0.3, -0.09],
		[0.25, -0.09],
		[0.38, -0.085],
		[0.44, -0.06],
		[0.48, -0.02],
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

	const tanks: Block[] = [];
	const tankCount = 5;
	const tankX1 = -0.25;
	const tankX2 = 0.26;
	const tankW = (tankX2 - tankX1) / tankCount;
	const gap = tankW * 0.06;

	for (let i = 0; i < tankCount; i++) {
		const x1 = tankX1 + i * tankW + gap;
		const x2 = tankX1 + (i + 1) * tankW - gap;
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
			{ outline: hull, baseHeight: 0, topHeight: 0.1 },
			{
				outline: forecastle,
				baseHeight: 0.1,
				topHeight: 0.16,
				topColor: STEEL,
				topAlpha: 0.8,
			},
			...tanks,
			{ outline: bridge, baseHeight: 0.1, topHeight: 0.3, topColor: STEEL },
			{ outline: funnel, baseHeight: 0.3, topHeight: 0.4, topColor: 0x333333 },
		],
		details: [
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
			{
				kind: "circle",
				height: 0.28,
				cx: 0.42,
				cy: 0,
				r: 0.006,
				color: STEEL,
				alpha: 0.6,
			},
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

function truckModel(): VehicleModel {
	const chassis: LP[] = [
		[0.42, -0.16],
		[0.42, 0.16],
		[-0.46, 0.16],
		[-0.46, -0.16],
	];

	const cab: LP[] = [
		[0.44, -0.17],
		[0.44, 0.17],
		[0.1, 0.17],
		[0.1, -0.17],
	];

	const cargoBox: LP[] = [
		[0.07, -0.18],
		[0.07, 0.18],
		[-0.48, 0.18],
		[-0.48, -0.18],
	];

	return {
		blocks: [
			{
				outline: chassis,
				baseHeight: 0,
				topHeight: 0.1,
				topColor: 0x333333,
			},
			{
				outline: cab,
				baseHeight: 0.1,
				topHeight: 0.5,
			},
			{
				outline: cargoBox,
				baseHeight: 0.1,
				topHeight: 0.6,
			},
		],
		details: [
			{
				kind: "line",
				height: 0.5,
				x1: 0.44,
				y1: -0.14,
				x2: 0.44,
				y2: 0.14,
				color: GLASS,
				width: 2,
				alpha: 0.8,
			},
			{
				kind: "line",
				height: 0.06,
				x1: 0.46,
				y1: -0.15,
				x2: 0.46,
				y2: 0.15,
				color: 0x444444,
				width: 1.5,
				alpha: 0.7,
			},
			{
				kind: "line",
				height: 0.06,
				x1: -0.49,
				y1: -0.15,
				x2: -0.49,
				y2: 0.15,
				color: 0x444444,
				width: 1.5,
				alpha: 0.7,
			},
			{
				kind: "circle",
				height: 0.04,
				cx: 0.3,
				cy: -0.17,
				r: 0.04,
				color: 0x222222,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.04,
				cx: 0.3,
				cy: 0.17,
				r: 0.04,
				color: 0x222222,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.04,
				cx: -0.3,
				cy: -0.17,
				r: 0.04,
				color: 0x222222,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.04,
				cx: -0.3,
				cy: 0.17,
				r: 0.04,
				color: 0x222222,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.2,
				cx: 0.45,
				cy: -0.12,
				r: 0.015,
				color: 0xffffcc,
				alpha: 0.9,
			},
			{
				kind: "circle",
				height: 0.2,
				cx: 0.45,
				cy: 0.12,
				r: 0.015,
				color: 0xffffcc,
				alpha: 0.9,
			},
		],
	};
}

function quadcopterModel(): VehicleModel {
	const body: LP[] = [
		[0.15, -0.1],
		[0.15, 0.1],
		[-0.15, 0.1],
		[-0.15, -0.1],
	];

	return {
		blocks: [{ outline: body, baseHeight: 0.2, topHeight: 0.35 }],
		details: [
			{
				kind: "line",
				height: 0.28,
				x1: 0.12,
				y1: -0.08,
				x2: 0.38,
				y2: -0.38,
				color: 0x444444,
				width: 2,
				alpha: 0.8,
			},
			{
				kind: "line",
				height: 0.28,
				x1: 0.12,
				y1: 0.08,
				x2: 0.38,
				y2: 0.38,
				color: 0x444444,
				width: 2,
				alpha: 0.8,
			},
			{
				kind: "line",
				height: 0.28,
				x1: -0.12,
				y1: -0.08,
				x2: -0.38,
				y2: -0.38,
				color: 0x444444,
				width: 2,
				alpha: 0.8,
			},
			{
				kind: "line",
				height: 0.28,
				x1: -0.12,
				y1: 0.08,
				x2: -0.38,
				y2: 0.38,
				color: 0x444444,
				width: 2,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.3,
				cx: 0.38,
				cy: -0.38,
				r: 0.04,
				color: 0x333333,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.3,
				cx: 0.38,
				cy: 0.38,
				r: 0.04,
				color: 0x333333,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.3,
				cx: -0.38,
				cy: -0.38,
				r: 0.04,
				color: 0x333333,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.3,
				cx: -0.38,
				cy: 0.38,
				r: 0.04,
				color: 0x333333,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.35,
				cx: 0.38,
				cy: -0.38,
				r: 0.15,
				color: 0xaaaaaa,
				alpha: 0.15,
			},
			{
				kind: "circle",
				height: 0.35,
				cx: 0.38,
				cy: 0.38,
				r: 0.15,
				color: 0xaaaaaa,
				alpha: 0.15,
			},
			{
				kind: "circle",
				height: 0.35,
				cx: -0.38,
				cy: -0.38,
				r: 0.15,
				color: 0xaaaaaa,
				alpha: 0.15,
			},
			{
				kind: "circle",
				height: 0.35,
				cx: -0.38,
				cy: 0.38,
				r: 0.15,
				color: 0xaaaaaa,
				alpha: 0.15,
			},
			{
				kind: "circle",
				height: 0.2,
				cx: 0.05,
				cy: 0,
				r: 0.025,
				color: 0x222222,
				alpha: 0.8,
			},
		],
	};
}

function shahedModel(): VehicleModel {
	const wing: LP[] = [
		[0.5, 0],
		[0.2, -0.06],
		[-0.15, -0.35],
		[-0.25, -0.35],
		[-0.35, -0.06],
		[-0.4, 0],
		[-0.35, 0.06],
		[-0.25, 0.35],
		[-0.15, 0.35],
		[0.2, 0.06],
	];

	const fuselage: LP[] = [
		[0.45, -0.04],
		[0.45, 0.04],
		[-0.35, 0.05],
		[-0.35, -0.05],
	];

	return {
		blocks: [
			{ outline: wing, baseHeight: 0.15, topHeight: 0.2 },
			{ outline: fuselage, baseHeight: 0.15, topHeight: 0.3 },
		],
		details: [
			{
				kind: "circle",
				height: 0.25,
				cx: 0.48,
				cy: 0,
				r: 0.025,
				color: 0x555555,
				alpha: 0.8,
			},
			{
				kind: "circle",
				height: 0.22,
				cx: -0.42,
				cy: 0,
				r: 0.03,
				color: 0x444444,
				alpha: 0.7,
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Model cache
// ---------------------------------------------------------------------------

const modelCache = new Map<VehicleType, VehicleModel>();

export function getModel(type: VehicleType): VehicleModel {
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
			case "truck":
				model = truckModel();
				break;
			case "quadcopter":
				model = quadcopterModel();
				break;
			case "shahed":
				model = shahedModel();
				break;
		}
		modelCache.set(type, model);
	}
	return model;
}
