/**
 * Tanker variety — every civilian tanker gets a deterministic design from
 * its entity id, so all clients see the same ship.
 *
 * Shape and paint are chosen independently: a handful of hull/deck
 * layouts (crude carriers, product tankers, Moss and membrane LNG
 * carriers) are shared geometry, while liveries are per-ship palettes.
 * Everything stays inside the oil_tanker collision footprint.
 */

export type TankerClass = "crude" | "product" | "lng_moss" | "lng_membrane";

/** Colours (sRGB hex) that the ship's paint slots resolve to. */
export interface TankerLivery {
	hull: number;
	bottom: number;
	deck: number;
	house: number;
	funnel: number;
	band: number;
}

export interface TankerShape {
	tankerClass: TankerClass;
	/** Accommodation decks above the main deck (taller block = more decks). */
	houseDecks: number;
	/** Deck height above the waterline, as a fraction of length (laden ships sit lower). */
	freeboard: number;
	/** Half-beam scale relative to the collision footprint (≤ 1). */
	beamScale: number;
	/** Funnel shape: raked modern stack or upright traditional one. */
	funnel: "raked" | "upright";
	/** Midship hose-handling cranes. */
	cranes: 1 | 2;
}

export interface TankerDesign {
	shape: TankerShape;
	livery: TankerLivery;
}

interface ClassStyle {
	tankerClass: TankerClass;
	weight: number;
	hulls: number[];
	decks: number[];
	houses: number[];
	houseDecks: readonly number[];
	freeboards: readonly number[];
}

const BLACK = 0x1d1f22;
const MAROON = 0x5b1a18;
const NAVY = 0x1b2a4a;
const DARK_GREEN = 0x1f3b2c;
const STEEL_GREY = 0x50555a;
const OXBLOOD = 0x7a1c16;
const COBALT = 0x1d4a86;
const SIGNAL_RED = 0xa3221c;
const SEA_GREEN = 0x2e6b3a;
const ORANGE = 0xc75a1a;
const TEAL = 0x1f6670;

const WHITE = 0xe9e8e2;
const CREAM = 0xe4dcc6;
const PALE_GREY = 0xc9ccce;

const CLASS_STYLES: ClassStyle[] = [
	{
		tankerClass: "crude",
		weight: 5,
		hulls: [BLACK, MAROON, NAVY, DARK_GREEN, STEEL_GREY, OXBLOOD, COBALT],
		decks: [0x3c5a3a, 0x6b2f22, 0x5a5d5f, 0x2f4a33, 0x7a3a26],
		houses: [WHITE, CREAM, PALE_GREY],
		houseDecks: [5, 6, 7],
		freeboards: [0.055, 0.065, 0.08],
	},
	{
		tankerClass: "product",
		weight: 3,
		hulls: [SIGNAL_RED, COBALT, SEA_GREEN, ORANGE, TEAL, BLACK],
		decks: [0x3c5a3a, 0x6b2f22, 0x8a3324, 0x45604a],
		houses: [WHITE, CREAM],
		houseDecks: [4, 5],
		freeboards: [0.06, 0.075],
	},
	{
		tankerClass: "lng_moss",
		weight: 1.5,
		hulls: [MAROON, BLACK, NAVY, OXBLOOD],
		decks: [0x5a5d5f, 0x6b2f22],
		houses: [WHITE],
		houseDecks: [6, 7],
		freeboards: [0.085, 0.095],
	},
	{
		tankerClass: "lng_membrane",
		weight: 1.5,
		hulls: [NAVY, BLACK, TEAL, MAROON],
		decks: [0x5a5d5f, 0x3c5a3a],
		houses: [WHITE, PALE_GREY],
		houseDecks: [6, 7],
		freeboards: [0.08, 0.09],
	},
];

const BOTTOMS = [0x8c2a22, 0x6e2a26, 0x2a2a2c];

/** Funnel livery pairs: [funnel colour, band colour]. */
const FUNNELS: [number, number][] = [
	[BLACK, 0xb5262a],
	[0xb5262a, WHITE],
	[COBALT, WHITE],
	[0xd7a12a, BLACK],
	[WHITE, COBALT],
	[0x2f6b3c, 0xd7a12a],
	[0xc75a1a, BLACK],
	[0x6f7478, 0xb5262a],
	[WHITE, 0x1f6670],
	[BLACK, 0xd7a12a],
];

export function tankerDesignFor(entityId: number): TankerDesign {
	const random = seededRandom(entityId);
	const style = weightedPick(CLASS_STYLES, random());
	const [funnel, band] = pick(FUNNELS, random());
	return {
		shape: {
			tankerClass: style.tankerClass,
			houseDecks: pick(style.houseDecks, random()),
			freeboard: pick(style.freeboards, random()),
			beamScale: 0.94 + random() * 0.06,
			funnel: random() < 0.6 ? "raked" : "upright",
			cranes: random() < 0.5 ? 1 : 2,
		},
		livery: {
			hull: pick(style.hulls, random()),
			bottom: pick(BOTTOMS, random()),
			deck: pick(style.decks, random()),
			house: pick(style.houses, random()),
			funnel,
			band,
		},
	};
}

/** Stable key for sharing geometry between tankers of the same shape. */
export function tankerShapeKey(shape: TankerShape): string {
	return [
		shape.tankerClass,
		shape.houseDecks,
		shape.freeboard,
		// Beam variation is quantised so near-identical hulls share geometry.
		Math.round(shape.beamScale * 50) / 50,
		shape.funnel,
		shape.cranes,
	].join(":");
}

function pick<T>(items: readonly T[], r: number): T {
	return items[Math.min(items.length - 1, Math.floor(r * items.length))];
}

function weightedPick(styles: ClassStyle[], r: number): ClassStyle {
	const total = styles.reduce((sum, s) => sum + s.weight, 0);
	let threshold = r * total;
	for (const style of styles) {
		threshold -= style.weight;
		if (threshold < 0) return style;
	}
	return styles[styles.length - 1];
}

/** Hash an id into an independent PRNG stream (consecutive ids look unrelated). */
function seededRandom(id: number): () => number {
	let state = (Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
