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
 * Scenarios use open-water coordinates (60km, 43km) so both hosts' is_land
 * implementations agree (polygon ray-cast client-side, terrain grid server-side).
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

const SCENARIOS: Scenario[] = [
	{
		name: "tanker convoy: follower brakes behind leader",
		dt: 0.05,
		ticks: 3,
		entities: [
			ent({ id: 1, behavior: "tanker_transit", bot: bot(), x: WX, speed: 10 }),
			ent({
				id: 2,
				behavior: "tanker_transit",
				bot: bot(),
				x: WX + 200,
				speed: 5,
			}),
		],
		scents: [],
	},
	{
		name: "escort: two frigates split across two tankers",
		dt: 0.05,
		ticks: 3,
		entities: [
			ent({
				id: 1,
				type: "frigate",
				faction: "us",
				behavior: "escort",
				bot: bot(),
				x: WX,
				size: 100,
			}),
			ent({
				id: 2,
				type: "frigate",
				faction: "us",
				behavior: "escort",
				bot: bot(),
				x: WX,
				y: WY + 500,
				size: 100,
			}),
			ent({ id: 10, x: WX + 3000, y: WY - 500 }),
			ent({ id: 11, x: WX + 3000, y: WY + 500 }),
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
		name: "speedboat: frigate evasion overrides hunting",
		dt: 0.05,
		ticks: 3,
		entities: [
			ent({
				id: 1,
				type: "speedboat",
				faction: "iran",
				behavior: "swarm_attack",
				bot: bot({ stamina: 0.5 }),
				x: WX,
				size: 20,
			}),
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
		name: "danger scent: frigate rushes, tanker drifts away",
		dt: 0.05,
		ticks: 4,
		entities: [
			ent({
				id: 1,
				type: "frigate",
				faction: "us",
				behavior: "escort",
				bot: bot(),
				x: WX,
				size: 100,
			}),
			ent({
				id: 10,
				behavior: "tanker_transit",
				bot: bot(),
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
	{
		name: "tanker at lane start advances waypoint",
		dt: 0.05,
		ticks: 2,
		entities: [
			ent({
				id: 1,
				behavior: "tanker_transit",
				bot: bot(),
				x: 76227,
				y: 52473,
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
