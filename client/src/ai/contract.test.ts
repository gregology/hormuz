/**
 * Cross-host AI contract test.
 *
 * Scenarios below run through both the browser-side fengari host (this file)
 * and the server-side lupa bridge (server/tests/test_ai_contract.py), using
 * the same committed fixture file (shared/ai/contract_fixtures.json) as the
 * source of truth. The fixture pins tick-by-tick control outputs so any
 * behavioral drift between the two Lua runtimes fails loudly.
 *
 * Regenerate after intentionally changing AI behavior:
 *   UPDATE_AI_FIXTURES=1 pnpm --filter @hormuz/client test -- contract
 * …then run the server tests to confirm the hosts still agree.
 *
 * Scenarios keep to open water (around 60 km, 43 km, or well clear of the
 * coast at the lane ends) so both hosts' is_land implementations agree
 * (polygon ray-cast client-side, terrain grid server-side).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLand } from "../map/terrain";
import { buildClientGameData } from "./game-data";
import type { AIBotState, AIControlOutput, AIEntitySnapshot } from "./lua-host";
import { LuaAIHost } from "./lua-host";

const FIXTURE_PATH = path.resolve(
	import.meta.dirname,
	"../../../shared/ai/contract_fixtures.json",
);
const UPDATE = process.env.UPDATE_AI_FIXTURES === "1";
const TOLERANCE = 1e-9;

interface ScentDef {
	x: number;
	y: number;
	at_tick: number;
}

interface Scenario {
	name: string;
	dt: number;
	ticks: number;
	entities: AIEntitySnapshot[];
	scents: ScentDef[];
	expected?: AIControlOutput[][];
}

// ---------------------------------------------------------------------------
// Scenario definitions (expected outputs are generated, not hand-written)
// ---------------------------------------------------------------------------

const WX = 60000;
const WY = 43000;

function bot(overrides: Partial<AIBotState> = {}): AIBotState {
	return {
		throttle: 0,
		rudder: 0,
		stamina: 1,
		waypoint_index: 0,
		target: 0,
		destination: "oman",
		group: 0,
		...overrides,
	};
}

function ent(
	overrides: Partial<AIEntitySnapshot> & { id: number },
): AIEntitySnapshot {
	return {
		type: "oil_tanker",
		faction: "civilian",
		x: WX,
		y: WY,
		heading: 0,
		speed: 10,
		hp: 100,
		airborne: false,
		size: 220,
		...overrides,
	};
}

// Outbound lane waypoints 1 and 2 (0-based), between which tankers are under way.
const WP1 = { x: 77877, y: 50890 };
const WP2 = { x: 79618, y: 49282 };
const LANE_HEADING = Math.atan2(WP2.y - WP1.y, WP2.x - WP1.x);

/** Tankers at the Gulf end of the outbound route, as they spawn there. */
function anchored(ids: number[]): AIEntitySnapshot[] {
	const spots = [
		{ x: 74000, y: 53800 },
		{ x: 74700, y: 53300 },
		{ x: 73400, y: 54300 },
	];
	return ids.map((id, i) =>
		ent({
			id,
			behavior: "tanker_transit",
			bot: bot(),
			...spots[i],
			heading: 5.5,
			speed: 0,
		}),
	);
}

function frigate(
	overrides: Partial<AIEntitySnapshot> & { id: number },
): AIEntitySnapshot {
	return ent({
		type: "frigate",
		faction: "us",
		behavior: "escort",
		bot: bot(),
		size: 100,
		...overrides,
	});
}

function speedboat(
	overrides: Partial<AIEntitySnapshot> & { id: number },
): AIEntitySnapshot {
	return ent({
		type: "speedboat",
		faction: "iran",
		behavior: "swarm_attack",
		bot: bot(),
		size: 13,
		speed: 0,
		...overrides,
	});
}

/** The Bandar Abbas speedboat base, and open water 3 km from it. */
const BASE = { x: 76313, y: 45778 };
const PREY = { x: 77813, y: 48376 };

const SCENARIOS: Scenario[] = [
	{
		name: "convoy: anchored tankers wait while their escort is assigned",
		dt: 0.05,
		ticks: 3,
		entities: [
			...anchored([1, 2, 3]),
			frigate({ id: 4, x: 77880, y: 51086, speed: 0 }),
		],
		scents: [],
	},
	{
		name: "convoy: sails in column once its escort is on station",
		dt: 0.05,
		ticks: 24,
		entities: [
			...anchored([1, 2, 3]),
			frigate({ id: 4, x: 75500, y: 53000, heading: 5.5, speed: 10 }),
		],
		scents: [],
	},
	{
		name: "escort: two frigates split across two convoys",
		dt: 0.05,
		ticks: 2,
		entities: [
			...anchored([1, 2, 3]),
			ent({
				id: 5,
				behavior: "tanker_transit",
				bot: bot({ destination: "gulf" }),
				x: 92900,
				y: 61200,
				heading: 4.2,
				speed: 0,
			}),
			frigate({ id: 8, x: 77880, y: 51086, speed: 0 }),
			frigate({ id: 9, x: 78180, y: 51086, speed: 0 }),
		],
		scents: [],
	},
	{
		name: "tanker under way advances waypoint",
		dt: 0.05,
		ticks: 2,
		entities: [
			ent({
				id: 1,
				behavior: "tanker_transit",
				bot: bot({ waypoint_index: 1 }),
				x: WP1.x + 100,
				y: WP1.y,
				heading: LANE_HEADING,
			}),
		],
		scents: [],
	},
	{
		name: "shaheds: one jammed near frigate, one hunts",
		dt: 0.05,
		ticks: 3,
		entities: [
			ent({
				id: 1,
				type: "shahed",
				faction: "iran",
				behavior: "shahed_intercept",
				bot: bot(),
				x: WX,
				y: WY - 2000,
				airborne: true,
				size: 4,
				speed: 80,
			}),
			ent({
				id: 2,
				type: "shahed",
				faction: "iran",
				behavior: "shahed_intercept",
				bot: bot(),
				x: WX,
				y: WY + 2000,
				airborne: true,
				size: 4,
				speed: 80,
			}),
			ent({
				id: 3,
				type: "frigate",
				faction: "us",
				x: WX + 500,
				y: WY - 2000,
				size: 100,
			}),
			ent({ id: 10, x: WX + 3000, y: WY - 500 }),
			ent({ id: 11, x: WX + 3000, y: WY + 500 }),
		],
		scents: [],
	},
	{
		name: "speedboats: rested pair musters against an unescorted tanker",
		dt: 0.05,
		ticks: 3,
		entities: [
			speedboat({ id: 1, x: BASE.x, y: BASE.y, heading: 0.8 }),
			speedboat({ id: 2, x: BASE.x + 150, y: BASE.y, heading: 0.8 }),
			ent({ id: 10, x: PREY.x, y: PREY.y }),
		],
		scents: [],
	},
	{
		name: "speedboat: frigate evasion overrides everything",
		dt: 0.05,
		ticks: 3,
		entities: [
			speedboat({ id: 1, x: WX, speed: 30, bot: bot({ stamina: 0.5 }) }),
			ent({
				id: 3,
				type: "frigate",
				faction: "us",
				x: WX + 500,
				y: WY + 100,
				size: 100,
			}),
			ent({ id: 10, x: WX, y: WY + 2000 }),
		],
		scents: [],
	},
	{
		name: "danger scent: tanker under way drifts away while escorted",
		dt: 0.05,
		ticks: 4,
		entities: [
			frigate({ id: 1, x: WX }),
			ent({
				id: 10,
				behavior: "tanker_transit",
				bot: bot({ waypoint_index: 3 }),
				x: WX + 2000,
				y: WY + 1000,
			}),
		],
		scents: [{ x: WX + 4000, y: WY, at_tick: 1 }],
	},
	{
		name: "quadcopters: spread across mixed targets",
		dt: 0.05,
		ticks: 3,
		entities: [
			ent({
				id: 1,
				type: "quadcopter",
				faction: "iran",
				behavior: "quadcopter_intercept",
				bot: bot(),
				x: WX,
				airborne: true,
				size: 2,
				speed: 30,
			}),
			ent({
				id: 2,
				type: "quadcopter",
				faction: "iran",
				behavior: "quadcopter_intercept",
				bot: bot(),
				x: WX,
				y: WY + 200,
				airborne: true,
				size: 2,
				speed: 30,
			}),
			ent({ id: 10, x: WX + 2000, y: WY - 300 }),
			ent({
				id: 11,
				type: "frigate",
				faction: "us",
				x: WX + 2000,
				y: WY + 300,
				size: 100,
			}),
		],
		scents: [],
	},
];

// ---------------------------------------------------------------------------
// Runner — mirrors server/tests/test_ai_contract.py exactly
// ---------------------------------------------------------------------------

interface AIHost {
	compute(
		entities: AIEntitySnapshot[],
		dt: number,
		time: number,
	): { controls: AIControlOutput[]; errors: string[] };
	addScent(x: number, y: number): void;
}

function runScenario(host: AIHost, scn: Scenario): AIControlOutput[][] {
	const botStates = new Map<number, AIBotState>();
	for (const e of scn.entities) {
		if (e.bot) botStates.set(e.id, { ...e.bot });
	}
	const ticks: AIControlOutput[][] = [];
	for (let tick = 0; tick < scn.ticks; tick++) {
		for (const s of scn.scents) {
			if (s.at_tick === tick) host.addScent(s.x, s.y);
		}
		const entities = scn.entities.map((e) => ({
			...e,
			bot: e.bot ? botStates.get(e.id) : undefined,
		}));
		const { controls, errors } = host.compute(
			entities,
			scn.dt,
			(tick + 1) * scn.dt,
		);
		if (errors.length > 0) {
			throw new Error(
				`scenario "${scn.name}" tick ${tick}: ${errors.join("; ")}`,
			);
		}
		for (const c of controls) {
			const prev = botStates.get(c.id);
			if (prev) {
				botStates.set(c.id, {
					...prev,
					throttle: c.throttle,
					rudder: c.rudder,
					target: c.target,
					waypoint_index: c.waypoint_index,
					stamina: c.stamina,
					group: c.group,
				});
			}
		}
		ticks.push(controls);
	}
	return ticks;
}

function expectControlsClose(
	actual: AIControlOutput[][],
	expected: AIControlOutput[][],
	context: string,
): void {
	expect(actual.length, `${context}: tick count`).toBe(expected.length);
	for (let t = 0; t < expected.length; t++) {
		expect(actual[t].length, `${context} tick ${t}: control count`).toBe(
			expected[t].length,
		);
		for (let i = 0; i < expected[t].length; i++) {
			const a = actual[t][i];
			const e = expected[t][i];
			const where = `${context} tick ${t} entity ${e.id}`;
			expect(a.id, where).toBe(e.id);
			expect(a.target, where).toBe(e.target);
			expect(a.waypoint_index, where).toBe(e.waypoint_index);
			expect(a.group, where).toBe(e.group);
			for (const key of ["throttle", "rudder", "stamina"] as const) {
				expect(
					Math.abs(a[key] - e[key]),
					`${where} ${key}: ${a[key]} vs ${e[key]}`,
				).toBeLessThanOrEqual(TOLERANCE);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Update mode: regenerate the fixture file from the current implementation
// ---------------------------------------------------------------------------

if (UPDATE) {
	const fixtures = SCENARIOS.map((scn) => ({
		name: scn.name,
		dt: scn.dt,
		ticks: scn.ticks,
		entities: scn.entities,
		scents: scn.scents,
		expected: runScenario(
			new LuaAIHost({ isLand, gameData: buildClientGameData() }),
			scn,
		),
	}));
	writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixtures, null, 2)}\n`);
	console.log(`wrote ${fixtures.length} scenarios to ${FIXTURE_PATH}`);
}

// ---------------------------------------------------------------------------
// Assert mode: compare this host against the committed fixtures
// ---------------------------------------------------------------------------

function readFixtures(): Scenario[] {
	try {
		return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Scenario[];
	} catch (cause) {
		throw new Error(
			`AI fixtures unreadable at ${FIXTURE_PATH} — regenerate with UPDATE_AI_FIXTURES=1`,
			{ cause },
		);
	}
}

describe("AI contract fixtures (client host)", () => {
	const fixtures = readFixtures();
	for (const scn of fixtures) {
		it(scn.name, () => {
			const host = new LuaAIHost({ isLand, gameData: buildClientGameData() });
			const actual = runScenario(host, scn);
			expectControlsClose(actual, scn.expected ?? [], scn.name);
		});
	}
});
