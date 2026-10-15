/**
 * Vehicle model definitions — pure geometry data shared by the renderer
 * and the sinking effect (no Three.js here).
 *
 * A model is a list of parts: a lofted hull (smooth cross-sections with
 * flare, sheer and a boot-top), boxes, cylinders, spheres and extruded
 * plan outlines. Each part carries a Paint; paint colours are either fixed
 * or a palette slot, resolved per vehicle so many liveries can share one
 * geometry (see tanker-variants.ts).
 *
 * Coordinates are fractions of the vehicle's `size`:
 *   [forward, up, starboard]  (up = 0 at the waterline)
 */

import type { VehicleType } from "../vehicles/physics";
import {
	type TankerShape,
	tankerDesignFor,
	tankerShapeKey,
} from "./tanker-variants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type V3 = readonly [number, number, number];

export type PaletteSlot =
	| "hull"
	| "bottom"
	| "deck"
	| "house"
	| "funnel"
	| "band";
export type Palette = Record<PaletteSlot, number>;

export interface Paint {
	/** sRGB hex, or a palette slot resolved per vehicle. */
	color: number | PaletteSlot;
	roughness: number;
	metalness?: number;
	/** sRGB hex emitted after dark (windows, lamps); scaled by time of day. */
	glow?: number;
}

export interface HullSpec {
	/** Plan half-beam at stations [x, halfBeam], stern → bow. */
	stations: readonly (readonly [number, number])[];
	/** Deck height above the waterline amidships. */
	freeboard: number;
	/** Extra deck height towards the bow. */
	sheer: number;
	/** Keel depth below the waterline. */
	draft: number;
	/** How much narrower the waterline is than the deck edge (0..0.5). */
	flare: number;
	/** 0 = flat-bottomed, 1 = deep V. */
	deadrise: number;
	/** Height of the dark boot-top band above the waterline (0 = none). */
	bootTop: number;
	/** Deck crown at the centreline, as a fraction of half-beam. */
	camber: number;
	topsides: Paint;
	boot: Paint;
	bottom: Paint;
	deck: Paint;
}

export type Part =
	| { kind: "hull"; spec: HullSpec }
	| {
			kind: "box";
			center: V3;
			size: V3;
			paint: Paint;
			/** Roof paint (defaults to `paint`). */
			top?: Paint;
			/** Fraction by which the top face shrinks (sloped, stealthy sides). */
			taper?: number;
			/** Rotation about the vertical axis, then about the starboard axis (radians). */
			yaw?: number;
			pitch?: number;
	  }
	| {
			kind: "cylinder";
			from: V3;
			to: V3;
			radius: number;
			radiusTo?: number;
			paint: Paint;
			segments?: number;
	  }
	| {
			kind: "sphere";
			center: V3;
			radius: number;
			paint: Paint;
			/** Only the upper hemisphere (domes). */
			dome?: boolean;
			/** Per-axis scale. */
			scale?: V3;
	  }
	| {
			kind: "prism";
			/** Plan outline [forward, starboard], counter-clockwise from above. */
			outline: readonly (readonly [number, number])[];
			base: number;
			top: number;
			paint: Paint;
	  };

export interface Rotor {
	center: V3;
	radius: number;
	blades: number;
	/** Spin axis: "up" for rotors, "forward" for a pusher propeller. */
	axis: "up" | "forward";
}

/** A point light drawn as a glowing sprite (navigation lights, headlights). */
export interface Lamp {
	position: V3;
	color: number;
	/** Always visible (strobe/nav) vs night-only. */
	always?: boolean;
	blink?: boolean;
}

export interface VehicleModel {
	parts: Part[];
	rotors?: Rotor[];
	lamps?: Lamp[];
	/** Mount point for the rotating CIWS turret (frigates). */
	ciws?: V3;
}

export interface VehicleAppearance {
	/** Geometry is shared between vehicles with the same key. */
	shapeKey: string;
	palette: Palette;
	build: () => VehicleModel;
}

// ---------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------

function paint(
	color: Paint["color"],
	roughness: number,
	metalness = 0,
	glow?: number,
): Paint {
	return { color, roughness, metalness, glow };
}

const HULL = paint("hull", 0.55, 0.15);
const BOTTOM = paint("bottom", 0.7, 0.05);
const DECK = paint("deck", 0.8, 0.05);
const HOUSE = paint("house", 0.6, 0.1);
const FUNNEL = paint("funnel", 0.55, 0.1);
const BAND = paint("band", 0.55, 0.1);

const BOOT_BLACK = paint(0x1a1b1d, 0.65, 0.1);
const PIPE = paint(0xb4b8ba, 0.45, 0.6);
const DARK_STEEL = paint(0x35393c, 0.5, 0.6);
const GUN_METAL = paint(0x3f474d, 0.45, 0.7);
const SOOT = paint(0x141414, 0.9);
const RUBBER = paint(0x161616, 0.9);
const LIFEBOAT = paint(0xf26a1b, 0.5);
const WHITE_GEAR = paint(0xe2e2dc, 0.6);
const CABIN_WINDOWS = paint(0x1b2530, 0.08, 0.3, 0xffcf80);
const BRIDGE_WINDOWS = paint(0x16202a, 0.06, 0.4, 0x6a5a40);
const DARK_GLASS = paint(0x101820, 0.06, 0.5);

const NAV_RED = 0xff2a1a;
const NAV_GREEN = 0x1aff5a;
const NAV_WHITE = 0xfff4dc;

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

function box(
	center: V3,
	size: V3,
	p: Paint,
	extra: Partial<Extract<Part, { kind: "box" }>> = {},
): Part {
	return { kind: "box", center, size, paint: p, ...extra };
}

function cylinder(
	from: V3,
	to: V3,
	radius: number,
	p: Paint,
	extra: Partial<Extract<Part, { kind: "cylinder" }>> = {},
): Part {
	return { kind: "cylinder", from, to, radius, paint: p, ...extra };
}

/** A multi-deck block with a window row on every deck (front and both sides). */
function deckhouse(options: {
	aft: number;
	fore: number;
	halfWidth: number;
	base: number;
	decks: number;
	deckHeight: number;
	paint: Paint;
	windows: Paint;
}): Part[] {
	const { aft, fore, halfWidth, base, decks, deckHeight, windows } = options;
	const height = decks * deckHeight;
	const length = fore - aft;
	const parts: Part[] = [
		box(
			[(fore + aft) / 2, base + height / 2, 0],
			[length, height, halfWidth * 2],
			options.paint,
		),
	];
	const inset = 0.0008;
	for (let deck = 0; deck < decks; deck++) {
		const y = base + (deck + 0.55) * deckHeight;
		const h = deckHeight * 0.32;
		parts.push(
			box([fore + inset, y, 0], [0.0015, h, halfWidth * 1.7], windows),
			box(
				[(fore + aft) / 2, y, halfWidth + inset],
				[length * 0.8, h, 0.0015],
				windows,
			),
			box(
				[(fore + aft) / 2, y, -halfWidth - inset],
				[length * 0.8, h, 0.0015],
				windows,
			),
		);
	}
	return parts;
}

/** Ship's funnel with a livery band and a sooty top. */
function funnelStack(options: {
	x: number;
	base: number;
	top: number;
	length: number;
	width: number;
	rake: number;
}): Part[] {
	const { x, base, top, length, width, rake } = options;
	const height = top - base;
	const lean = (y: number) => x - Math.tan(rake) * (y - base);
	const mid = (base + top) / 2;
	return [
		box([lean(mid), mid, 0], [length, height, width], FUNNEL, {
			pitch: rake,
			taper: 0.1,
		}),
		box(
			[lean(base + height * 0.72), base + height * 0.72, 0],
			[length * 0.97, height * 0.14, width * 1.02],
			BAND,
			{ pitch: rake },
		),
		box(
			[lean(top - height * 0.04), top - height * 0.04, 0],
			[length * 0.92, height * 0.08, width * 0.95],
			SOOT,
			{ pitch: rake },
		),
	];
}

/** Interpolated plan half-beam of a station list at x (0 outside the hull). */
export function halfBeamAt(stations: HullSpec["stations"], x: number): number {
	if (x < stations[0][0] || x > stations[stations.length - 1][0]) return 0;
	for (let i = 0; i < stations.length - 1; i++) {
		const [x0, b0] = stations[i];
		const [x1, b1] = stations[i + 1];
		if (x <= x1) return b0 + ((b1 - b0) * (x - x0)) / (x1 - x0);
	}
	return stations[stations.length - 1][1];
}

/** Deck height of a hull at x (freeboard plus sheer rising to the bow). */
export function deckHeightAt(spec: HullSpec, x: number): number {
	const bow = spec.stations[spec.stations.length - 1][0];
	const t = Math.max(0, Math.min(1, (x - (bow - 0.3)) / 0.3));
	return spec.freeboard + spec.sheer * t * t;
}

// ---------------------------------------------------------------------------
// Oil and gas tankers
// ---------------------------------------------------------------------------

const TANKER_STATIONS: [number, number][] = [
	[-0.455, 0.052],
	[-0.445, 0.066],
	[-0.425, 0.078],
	[-0.39, 0.086],
	[-0.34, 0.09],
	[0.27, 0.09],
	[0.34, 0.087],
	[0.39, 0.079],
	[0.43, 0.066],
	[0.46, 0.05],
	[0.48, 0.034],
	[0.493, 0.017],
	[0.5, 0],
];

function tankerModel(shape: TankerShape): VehicleModel {
	const beam = shape.beamScale;
	const deck = shape.freeboard;
	const spec: HullSpec = {
		stations: TANKER_STATIONS.map(([x, b]) => [x, b * beam] as const),
		freeboard: deck,
		sheer: 0.016,
		draft: 0.07,
		flare: 0.02,
		deadrise: 0,
		bootTop: 0.012,
		camber: 0.05,
		topsides: HULL,
		boot: BOOT_BLACK,
		bottom: BOTTOM,
		deck: DECK,
	};
	const parts: Part[] = [{ kind: "hull", spec }];
	const lamps: Lamp[] = [];
	const halfBeam = 0.09 * beam;

	// --- Accommodation, bridge and funnel aft ---
	const deckHeight = 0.022;
	const houseTop = deck + shape.houseDecks * deckHeight;
	const houseHalf = 0.068 * beam;
	parts.push(
		...deckhouse({
			aft: -0.39,
			fore: -0.305,
			halfWidth: houseHalf,
			base: deck,
			decks: shape.houseDecks,
			deckHeight,
			paint: HOUSE,
			windows: CABIN_WINDOWS,
		}),
		// Bridge with wings out to the ship's side
		box(
			[-0.322, houseTop + 0.011, 0],
			[0.038, 0.022, halfBeam * 2 - 0.004],
			HOUSE,
		),
		box(
			[-0.302, houseTop + 0.013, 0],
			[0.0015, 0.009, halfBeam * 1.8],
			BRIDGE_WINDOWS,
		),
		box(
			[-0.335, houseTop + 0.0225, 0],
			[0.05, 0.0015, houseHalf * 1.6],
			DARK_STEEL,
		),
		// Engine casing between accommodation and funnel
		box([-0.41, deck + 0.035, 0], [0.04, 0.07, houseHalf * 1.3], HOUSE),
	);
	const funnelBase = deck + 0.06;
	const funnelTop = houseTop + (shape.funnel === "raked" ? 0.045 : 0.035);
	parts.push(
		...funnelStack({
			x: -0.415,
			base: funnelBase,
			top: funnelTop,
			length: shape.funnel === "raked" ? 0.034 : 0.026,
			width: shape.funnel === "raked" ? 0.03 : 0.036,
			rake: shape.funnel === "raked" ? 0.22 : 0.05,
		}),
	);
	// Radar mast and scanners on the bridge roof
	const mastTop = houseTop + 0.07;
	parts.push(
		cylinder(
			[-0.33, houseTop + 0.022, 0],
			[-0.33, mastTop, 0],
			0.0025,
			WHITE_GEAR,
		),
		box([-0.33, houseTop + 0.05, 0], [0.004, 0.0025, 0.03], DARK_STEEL),
		box([-0.33, houseTop + 0.038, 0], [0.003, 0.002, 0.022], DARK_STEEL),
	);
	// Free-fall lifeboat on its stern ramp, life-raft canisters, mooring gear
	parts.push(
		box([-0.448, deck + 0.026, 0], [0.034, 0.013, 0.013], LIFEBOAT, {
			pitch: 0.45,
		}),
		box([-0.446, deck + 0.014, 0], [0.03, 0.004, 0.02], DARK_STEEL, {
			pitch: 0.45,
		}),
		cylinder(
			[-0.36, deck + 0.03, houseHalf + 0.004],
			[-0.345, deck + 0.03, houseHalf + 0.004],
			0.0035,
			WHITE_GEAR,
		),
		cylinder(
			[-0.36, deck + 0.03, -houseHalf - 0.004],
			[-0.345, deck + 0.03, -houseHalf - 0.004],
			0.0035,
			WHITE_GEAR,
		),
		box([-0.44, deck + 0.006, 0.035], [0.012, 0.012, 0.016], DARK_STEEL),
		box([-0.44, deck + 0.006, -0.035], [0.012, 0.012, 0.016], DARK_STEEL),
	);
	lamps.push(
		{ position: [-0.33, mastTop + 0.002, 0], color: NAV_WHITE },
		{
			position: [-0.322, houseTop + 0.014, halfBeam - 0.002],
			color: NAV_GREEN,
		},
		{ position: [-0.322, houseTop + 0.014, -halfBeam + 0.002], color: NAV_RED },
		{ position: [-0.452, deck + 0.04, 0], color: NAV_WHITE },
	);

	// --- Forecastle: windlasses and foremast ---
	const bowDeck = deckHeightAt(spec, 0.45);
	parts.push(
		box([0.445, bowDeck + 0.007, 0.022], [0.016, 0.014, 0.014], DARK_STEEL),
		box([0.445, bowDeck + 0.007, -0.022], [0.016, 0.014, 0.014], DARK_STEEL),
		cylinder(
			[0.462, bowDeck, 0],
			[0.462, bowDeck + 0.055, 0],
			0.0025,
			WHITE_GEAR,
		),
	);
	lamps.push({ position: [0.462, bowDeck + 0.057, 0], color: NAV_WHITE });

	// --- Cargo deck, by class ---
	const cargoAft = -0.29;
	const cargoFore = 0.4;
	if (shape.tankerClass === "lng_moss") {
		const radius = 0.074 * beam;
		const centres = [0.31, 0.15, -0.01, -0.17];
		for (const x of centres) {
			parts.push(
				{
					kind: "sphere",
					center: [x, deck + 0.022, 0],
					radius,
					paint: WHITE_GEAR,
					dome: true,
				},
				cylinder(
					[x, deck, 0],
					[x, deck + 0.024, 0],
					radius * 1.01,
					paint(0xa9adaf, 0.6, 0.3),
					{ segments: 24 },
				),
				cylinder(
					[x, deck + 0.022 + radius, 0],
					[x, deck + 0.022 + radius + 0.006, 0],
					0.008,
					PIPE,
				),
			);
		}
		parts.push(
			box([0.07, deck + 0.022 + radius + 0.01, 0], [0.5, 0.006, 0.012], PIPE),
		);
	} else if (shape.tankerClass === "lng_membrane") {
		const trunkHalf = 0.07 * beam;
		parts.push(
			box(
				[(cargoAft + 0.37) / 2, deck + 0.016, 0],
				[0.37 - cargoAft, 0.032, trunkHalf * 2],
				paint(0xb7bbbd, 0.65, 0.1),
				{
					top: paint(0xc4c7c8, 0.7, 0.1),
				},
			),
		);
		for (const x of [0.29, 0.13, -0.03, -0.19]) {
			parts.push(
				cylinder([x, deck + 0.032, 0], [x, deck + 0.046, 0], 0.012, PIPE),
			);
		}
		for (const z of [-0.02, 0.02]) {
			parts.push(
				cylinder(
					[cargoAft + 0.01, deck + 0.036, z],
					[0.36, deck + 0.036, z],
					0.0025,
					PIPE,
				),
			);
		}
	} else {
		const pipeZs =
			shape.tankerClass === "product"
				? [-0.03, -0.022, -0.014, 0.014, 0.022, 0.03]
				: [-0.018, -0.01, 0.01, 0.018];
		// Centreline catwalk with its pipe runs either side
		parts.push(
			box(
				[(cargoAft + cargoFore) / 2, deck + 0.013, 0],
				[cargoFore - cargoAft, 0.0025, 0.009],
				DARK_STEEL,
			),
		);
		for (const z of pipeZs) {
			parts.push(
				cylinder(
					[cargoAft, deck + 0.004, z],
					[cargoFore - 0.03, deck + 0.004, z],
					0.0022,
					PIPE,
					{ segments: 6 },
				),
			);
		}
		// Tank hatches / vent posts
		const hatchRows =
			shape.tankerClass === "product"
				? [-0.055, -0.042, 0.042, 0.055]
				: [-0.045, 0.045];
		for (
			let x = cargoAft + 0.03;
			x < cargoFore - 0.02;
			x += shape.tankerClass === "product" ? 0.045 : 0.08
		) {
			if (Math.abs(x) < 0.03) continue;
			for (const z of hatchRows) {
				parts.push(
					cylinder(
						[x, deck, z * beam],
						[x, deck + 0.007, z * beam],
						0.0055,
						PIPE,
						{ segments: 8 },
					),
				);
			}
		}
	}

	// Midship manifold and hose-handling cranes (all classes)
	for (const dx of [-0.012, -0.004, 0.004, 0.012]) {
		parts.push(
			cylinder(
				[dx, deck + 0.005, -halfBeam * 0.82],
				[dx, deck + 0.005, halfBeam * 0.82],
				0.0024,
				PIPE,
				{ segments: 6 },
			),
		);
	}
	const craneSides = shape.cranes === 2 ? [1, -1] : [1];
	for (const side of craneSides) {
		const z = side * halfBeam * 0.55;
		parts.push(
			cylinder(
				[0.025, deck, z],
				[0.025, deck + 0.045, z],
				0.0045,
				paint(0xd7a12a, 0.5, 0.3),
			),
			cylinder(
				[0.025, deck + 0.043, z],
				[0.075, deck + 0.05, z * 0.35],
				0.002,
				paint(0xd7a12a, 0.5, 0.3),
			),
		);
	}

	return { parts, lamps };
}

// ---------------------------------------------------------------------------
// US Navy frigate (Constellation-class inspired)
// ---------------------------------------------------------------------------

const HAZE_GREY = paint(0x7d868c, 0.6, 0.25);
const NONSKID = paint(0x3f4447, 0.85, 0.1);
const RADAR_FACE = paint(0x30363b, 0.4, 0.5);

/** CIWS / SeaRAM mount on the hangar roof (model-space fractions). */
export const CIWS_TURRET_POS = { x: -0.205, y: 0.152, z: 0 };

/** Muzzle tip offset from the turret group origin (turret-local space). */
export const CIWS_MUZZLE_OFFSET = { x: 0.05, y: 0.015, z: 0 };

function frigateModel(): VehicleModel {
	const deck = 0.07;
	const spec: HullSpec = {
		stations: [
			[-0.45, 0.056],
			[-0.4, 0.067],
			[-0.3, 0.077],
			[-0.15, 0.08],
			[0.0, 0.077],
			[0.12, 0.069],
			[0.24, 0.054],
			[0.34, 0.037],
			[0.43, 0.019],
			[0.5, 0],
		],
		freeboard: deck,
		sheer: 0.035,
		draft: 0.045,
		flare: 0.16,
		deadrise: 0.5,
		bootTop: 0.006,
		camber: 0.04,
		topsides: HAZE_GREY,
		boot: BOOT_BLACK,
		bottom: paint(0x7a2a24, 0.7),
		deck: NONSKID,
	};
	const gunDeck = deckHeightAt(spec, 0.3);
	const parts: Part[] = [
		{ kind: "hull", spec },
		// 57 mm gun: faceted stealth mount and barrel
		cylinder(
			[0.3, gunDeck - 0.005, 0],
			[0.3, gunDeck + 0.008, 0],
			0.017,
			HAZE_GREY,
		),
		box([0.3, gunDeck + 0.02, 0], [0.042, 0.022, 0.03], HAZE_GREY, {
			taper: 0.3,
		}),
		cylinder(
			[0.32, gunDeck + 0.021, 0],
			[0.4, gunDeck + 0.024, 0],
			0.0025,
			GUN_METAL,
		),
		// Mk 41 vertical launch cells
		box(
			[0.205, deck + 0.017, 0],
			[0.07, 0.008, 0.06],
			paint(0x2b2f31, 0.6, 0.3),
		),
		box(
			[0.205, deck + 0.0215, 0],
			[0.066, 0.001, 0.002],
			paint(0x55595c, 0.6, 0.3),
		),
		// Bridge superstructure, sloped sides, wraparound windows
		box([0.075, deck + 0.05, 0], [0.13, 0.1, 0.122], HAZE_GREY, {
			taper: 0.14,
		}),
		box([0.135, deck + 0.084, 0], [0.004, 0.012, 0.085], BRIDGE_WINDOWS, {
			pitch: 0.25,
		}),
		// Integrated mast with phased-array radar faces
		box([0.02, deck + 0.135, 0], [0.065, 0.075, 0.075], HAZE_GREY, {
			taper: 0.32,
		}),
		box([0.049, deck + 0.135, 0], [0.004, 0.038, 0.036], RADAR_FACE, {
			pitch: 0.28,
		}),
		box([0.02, deck + 0.135, 0.033], [0.036, 0.038, 0.004], RADAR_FACE),
		box([0.02, deck + 0.135, -0.033], [0.036, 0.038, 0.004], RADAR_FACE),
		cylinder([0.02, deck + 0.17, 0], [0.02, deck + 0.27, 0], 0.003, HAZE_GREY),
		box([0.02, deck + 0.235, 0], [0.004, 0.003, 0.05], HAZE_GREY),
		// Exhaust uptakes
		box([-0.08, deck + 0.065, 0], [0.065, 0.075, 0.075], HAZE_GREY, {
			taper: 0.22,
		}),
		box([-0.08, deck + 0.104, 0], [0.04, 0.006, 0.045], SOOT),
		// Hangar, with the door on its aft face
		box([-0.205, deck + 0.04, 0], [0.15, 0.08, 0.12], HAZE_GREY, {
			taper: 0.06,
		}),
		box(
			[-0.281, deck + 0.033, 0],
			[0.002, 0.06, 0.08],
			paint(0x6c7378, 0.6, 0.3),
		),
		// Flight deck markings
		box([-0.365, deck + 0.0012, 0], [0.15, 0.0015, 0.003], WHITE_GEAR),
		box([-0.4, deck + 0.0012, 0], [0.003, 0.0015, 0.07], WHITE_GEAR),
		// Boats and life-raft canisters
		box(
			[-0.12, deck + 0.022, 0.06],
			[0.05, 0.014, 0.018],
			paint(0xd25a1e, 0.6),
		),
		box(
			[-0.12, deck + 0.022, -0.06],
			[0.05, 0.014, 0.018],
			paint(0x50565a, 0.6),
		),
		cylinder(
			[0.0, deck + 0.015, 0.072],
			[0.025, deck + 0.015, 0.072],
			0.004,
			WHITE_GEAR,
		),
		cylinder(
			[0.0, deck + 0.015, -0.072],
			[0.025, deck + 0.015, -0.072],
			0.004,
			WHITE_GEAR,
		),
	];
	return {
		parts,
		ciws: [CIWS_TURRET_POS.x, CIWS_TURRET_POS.y, CIWS_TURRET_POS.z],
		lamps: [
			{ position: [0.02, deck + 0.275, 0], color: NAV_WHITE },
			{ position: [0.1, deck + 0.075, 0.062], color: NAV_GREEN },
			{ position: [0.1, deck + 0.075, -0.062], color: NAV_RED },
			{ position: [-0.448, deck + 0.01, 0], color: NAV_WHITE },
		],
	};
}

/** Phalanx-style turret, in the turret group's local space. */
export function ciwsTurretModel(): VehicleModel {
	return {
		parts: [
			cylinder([0, 0, 0], [0, 0.012, 0], 0.014, HAZE_GREY),
			box([0, 0.024, 0], [0.026, 0.024, 0.022], HAZE_GREY),
			cylinder([-0.002, 0.036, 0], [-0.002, 0.075, 0], 0.011, WHITE_GEAR, {
				radiusTo: 0.008,
			}),
			{
				kind: "sphere",
				center: [-0.002, 0.075, 0],
				radius: 0.008,
				paint: WHITE_GEAR,
				dome: true,
			},
			cylinder([0.012, 0.015, 0], [0.05, 0.015, 0], 0.003, GUN_METAL),
		],
	};
}

// ---------------------------------------------------------------------------
// IRGC fast attack craft (Boghammar / Taregh)
// ---------------------------------------------------------------------------

function speedboatModel(): VehicleModel {
	const deck = 0.1;
	const grey = paint(0x6d757a, 0.55, 0.2);
	const spec: HullSpec = {
		stations: [
			[-0.44, 0.085],
			[-0.35, 0.098],
			[-0.2, 0.104],
			[-0.05, 0.103],
			[0.1, 0.092],
			[0.22, 0.072],
			[0.32, 0.05],
			[0.42, 0.024],
			[0.5, 0],
		],
		freeboard: deck,
		sheer: 0.05,
		draft: 0.06,
		flare: 0.14,
		deadrise: 1,
		bootTop: 0,
		camber: 0,
		topsides: grey,
		boot: grey,
		bottom: paint(0x4a4f52, 0.6, 0.1),
		deck: paint(0x464b4e, 0.85),
	};
	const bowDeck = deckHeightAt(spec, 0.32);
	return {
		parts: [
			{ kind: "hull", spec },
			// Pilothouse and windscreen
			box([-0.06, deck + 0.07, 0], [0.16, 0.14, 0.12], grey, { taper: 0.14 }),
			box([0.017, deck + 0.105, 0], [0.004, 0.045, 0.09], DARK_GLASS, {
				pitch: 0.45,
			}),
			// 107 mm rocket launcher on the roof
			box(
				[-0.07, deck + 0.157, 0],
				[0.09, 0.034, 0.07],
				paint(0x4e5a3c, 0.6, 0.2),
			),
			box([-0.024, deck + 0.157, 0], [0.002, 0.028, 0.062], SOOT),
			// DShK heavy machine gun on the bow
			cylinder([0.3, bowDeck, 0], [0.3, bowDeck + 0.05, 0], 0.009, GUN_METAL),
			box([0.33, bowDeck + 0.055, 0], [0.06, 0.013, 0.013], GUN_METAL),
			cylinder(
				[0.36, bowDeck + 0.056, 0],
				[0.45, bowDeck + 0.058, 0],
				0.003,
				GUN_METAL,
			),
			// Twin outboards
			box(
				[-0.465, deck - 0.03, 0.035],
				[0.045, 0.13, 0.03],
				paint(0x1c1c1c, 0.4, 0.2),
				{ pitch: -0.12 },
			),
			box(
				[-0.465, deck - 0.03, -0.035],
				[0.045, 0.13, 0.03],
				paint(0x1c1c1c, 0.4, 0.2),
				{ pitch: -0.12 },
			),
		],
		lamps: [{ position: [-0.06, deck + 0.18, 0], color: NAV_WHITE }],
	};
}

// ---------------------------------------------------------------------------
// Shahed-136 loitering munition
// ---------------------------------------------------------------------------

function shahedModel(): VehicleModel {
	const skin = paint(0xa6a8a3, 0.55, 0.1);
	return {
		parts: [
			{
				kind: "prism",
				outline: [
					[0.42, 0],
					[0.15, 0.09],
					[-0.2, 0.34],
					[-0.27, 0.34],
					[-0.36, 0.06],
					[-0.36, -0.06],
					[-0.27, -0.34],
					[-0.2, -0.34],
					[0.15, -0.09],
				],
				base: 0.16,
				top: 0.18,
				paint: skin,
			},
			cylinder([-0.36, 0.18, 0], [0.4, 0.18, 0], 0.05, skin, { segments: 10 }),
			cylinder([0.4, 0.18, 0], [0.5, 0.18, 0], 0.05, skin, {
				radiusTo: 0.012,
				segments: 10,
			}),
			cylinder(
				[-0.36, 0.18, 0],
				[-0.43, 0.18, 0],
				0.035,
				paint(0x2a2a2a, 0.6, 0.4),
				{ segments: 10 },
			),
			box([-0.235, 0.205, 0.335], [0.11, 0.07, 0.008], skin),
			box([-0.235, 0.205, -0.335], [0.11, 0.07, 0.008], skin),
		],
		rotors: [
			{ center: [-0.445, 0.18, 0], radius: 0.13, blades: 2, axis: "forward" },
		],
		lamps: [
			{
				position: [-0.235, 0.24, 0.335],
				color: NAV_RED,
				always: true,
				blink: true,
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Quadcopter
// ---------------------------------------------------------------------------

function quadcopterModel(): VehicleModel {
	const carbon = paint(0x232527, 0.45, 0.3);
	const parts: Part[] = [
		box([0, 0.26, 0], [0.3, 0.09, 0.18], carbon),
		box([0, 0.31, 0], [0.22, 0.02, 0.14], paint(0x55595c, 0.4, 0.3)),
		{
			kind: "sphere",
			center: [0.16, 0.21, 0],
			radius: 0.045,
			paint: DARK_GLASS,
		},
	];
	const rotors: Rotor[] = [];
	for (const [sx, sz] of [
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
	]) {
		const tip: V3 = [sx * 0.27, 0.28, sz * 0.27];
		parts.push(
			cylinder([0, 0.27, 0], tip, 0.02, carbon, { segments: 6 }),
			cylinder(
				[tip[0], 0.27, tip[2]],
				[tip[0], 0.33, tip[2]],
				0.04,
				paint(0x6b6f72, 0.35, 0.8),
				{ segments: 10 },
			),
			cylinder([tip[0], 0.26, tip[2]], [tip[0], 0.16, tip[2]], 0.01, carbon, {
				segments: 4,
			}),
		);
		rotors.push({
			center: [tip[0], 0.34, tip[2]],
			radius: 0.16,
			blades: 2,
			axis: "up",
		});
	}
	return {
		parts,
		rotors,
		lamps: [
			{ position: [0.155, 0.27, 0], color: NAV_RED, always: true, blink: true },
		],
	};
}

// ---------------------------------------------------------------------------
// Box truck
// ---------------------------------------------------------------------------

function truckModel(): VehicleModel {
	const parts: Part[] = [
		box([-0.02, 0.12, 0], [0.88, 0.06, 0.28], DARK_STEEL),
		// Cab, windscreen and side windows
		box([0.31, 0.27, 0], [0.24, 0.28, 0.34], HOUSE, { taper: 0.05 }),
		box([0.432, 0.32, 0], [0.004, 0.11, 0.28], DARK_GLASS, { pitch: 0.12 }),
		box([0.33, 0.33, 0.171], [0.12, 0.09, 0.003], DARK_GLASS),
		box([0.33, 0.33, -0.171], [0.12, 0.09, 0.003], DARK_GLASS),
		// Cargo box
		box([-0.2, 0.36, 0], [0.56, 0.42, 0.36], HULL, {
			top: paint(0xb9bbb6, 0.7),
		}),
		box([-0.481, 0.36, 0], [0.003, 0.38, 0.33], paint(0x8d9093, 0.5, 0.4)),
	];
	for (const x of [0.3, -0.27, -0.39]) {
		for (const z of [0.15, -0.15]) {
			parts.push(
				cylinder([x, 0.075, z - 0.03], [x, 0.075, z + 0.03], 0.075, RUBBER, {
					segments: 10,
				}),
			);
		}
	}
	return {
		parts,
		lamps: [
			{ position: [0.442, 0.17, 0.12], color: NAV_WHITE },
			{ position: [0.442, 0.17, -0.12], color: NAV_WHITE },
			{ position: [-0.483, 0.17, 0.14], color: NAV_RED },
			{ position: [-0.483, 0.17, -0.14], color: NAV_RED },
		],
	};
}

// ---------------------------------------------------------------------------
// Appearance lookup
// ---------------------------------------------------------------------------

/** Colours for paint slots a vehicle doesn't use. */
const NEUTRAL: Palette = {
	hull: 0x7d868c,
	bottom: 0x7a2a24,
	deck: 0x3f4447,
	house: 0xe9e8e2,
	funnel: 0x1d1f22,
	band: 0xb5262a,
};

const TRUCK_BOXES = [
	0xe8e8e4, 0xe8e8e4, 0xb5262a, 0x1d4a86, 0x2f6b3c, 0xd7a12a, 0x9a9da0,
];
const TRUCK_CABS = [0xe8e8e4, 0xb5262a, 0x1d4a86, 0x6f7478, 0xd7d0bc];

const builtModels = new Map<string, VehicleModel>();

function cached(
	shapeKey: string,
	build: () => VehicleModel,
): () => VehicleModel {
	return () => {
		let model = builtModels.get(shapeKey);
		if (!model) {
			model = build();
			builtModels.set(shapeKey, model);
		}
		return model;
	};
}

export function vehicleAppearance(
	type: VehicleType,
	entityId: number,
): VehicleAppearance {
	switch (type) {
		case "oil_tanker": {
			const design = tankerDesignFor(entityId);
			const shapeKey = `oil_tanker:${tankerShapeKey(design.shape)}`;
			return {
				shapeKey,
				palette: design.livery,
				build: cached(shapeKey, () => tankerModel(design.shape)),
			};
		}
		case "truck": {
			const hash = Math.imul(entityId + 1, 0x9e3779b1) >>> 0;
			return {
				shapeKey: type,
				palette: {
					...NEUTRAL,
					hull: TRUCK_BOXES[hash % TRUCK_BOXES.length],
					house: TRUCK_CABS[(hash >>> 8) % TRUCK_CABS.length],
				},
				build: cached(type, truckModel),
			};
		}
		case "frigate":
			return {
				shapeKey: type,
				palette: NEUTRAL,
				build: cached(type, frigateModel),
			};
		case "speedboat":
			return {
				shapeKey: type,
				palette: NEUTRAL,
				build: cached(type, speedboatModel),
			};
		case "shahed":
			return {
				shapeKey: type,
				palette: NEUTRAL,
				build: cached(type, shahedModel),
			};
		case "quadcopter":
			return {
				shapeKey: type,
				palette: NEUTRAL,
				build: cached(type, quadcopterModel),
			};
	}
}
