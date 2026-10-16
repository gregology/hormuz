import { describe, expect, it } from "vitest";
import { buildClientGameData } from "./game-data";
import type { AIBotState, AIEntitySnapshot } from "./lua-host";
import { LuaAIHost } from "./lua-host";

function createHost(isLand: (x: number, y: number) => boolean = () => false) {
	return new LuaAIHost({ isLand, gameData: buildClientGameData() });
}

function botState(overrides: Partial<AIBotState> = {}): AIBotState {
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

function entity(overrides: Partial<AIEntitySnapshot>): AIEntitySnapshot {
	return {
		id: 1,
		type: "oil_tanker",
		faction: "civilian",
		x: 0,
		y: 0,
		heading: 0,
		speed: 10,
		hp: 100,
		airborne: false,
		size: 220,
		...overrides,
	};
}

describe("LuaAIHost", () => {
	it("loads scripts and returns config", () => {
		const host = createHost();
		const config = host.getConfigFlat();
		expect(config["tanker.brake_range"]).toBe(400);
		expect(config["convoy.spacing"]).toBe(700);
	});

	it("config writes take effect", () => {
		const host = createHost();
		host.setConfig("tanker.brake_range", 999);
		expect(host.getConfigFlat()["tanker.brake_range"]).toBe(999);
	});
});

// Outbound lane waypoints 1 and 2 (0-based): a tanker between them is under way.
const WP1 = { x: 77877, y: 50890 };
const WP2 = { x: 79618, y: 49282 };

describe("tanker_transit behavior", () => {
	it("steers for its next waypoint when under way on its own", () => {
		const host = createHost();
		const tanker = entity({
			id: 1,
			behavior: "tanker_transit",
			bot: botState({ waypoint_index: 2 }),
			x: WP1.x,
			y: WP1.y,
			heading: Math.atan2(WP2.y - WP1.y, WP2.x - WP1.x),
		});
		const { controls, errors } = host.compute([tanker], 0.05, 0);
		expect(errors).toEqual([]);
		expect(controls).toHaveLength(1);
		expect(controls[0].throttle).toBeGreaterThan(0.5);
		expect(Math.abs(controls[0].rudder)).toBeLessThan(0.01);
	});

	it("advances the waypoint index when close to the waypoint", () => {
		const host = createHost();
		const tanker = entity({
			id: 1,
			behavior: "tanker_transit",
			bot: botState({ waypoint_index: 1 }),
			x: WP1.x + 100,
			y: WP1.y,
		});
		const { controls } = host.compute([tanker], 0.05, 0);
		expect(controls[0].waypoint_index).toBe(2);
	});

	it("brakes behind a slower tanker ahead", () => {
		const host = createHost();
		const heading = Math.atan2(WP2.y - WP1.y, WP2.x - WP1.x);
		const under = (id: number, ahead: number, bot: AIBotState | undefined) =>
			entity({
				id,
				behavior: bot ? "tanker_transit" : undefined,
				bot,
				x: WP1.x + Math.cos(heading) * ahead,
				y: WP1.y + Math.sin(heading) * ahead,
				heading,
			});
		const alone = host.compute(
			[under(1, 0, botState({ waypoint_index: 2 }))],
			0.05,
			0,
		);
		const behind = createHost().compute(
			[under(1, 0, botState({ waypoint_index: 2 })), under(2, 200, undefined)],
			0.05,
			0,
		);
		expect(behind.controls[0].throttle).toBeLessThan(
			alone.controls[0].throttle,
		);
		expect(behind.controls[0].throttle).toBeGreaterThan(0.4);
	});
});

describe("shahed_intercept behavior", () => {
	it("steers toward the nearest civilian vessel", () => {
		const host = createHost();
		const shahed = entity({
			id: 1,
			type: "shahed",
			faction: "iran",
			airborne: true,
			size: 12,
			behavior: "shahed_intercept",
			bot: botState(),
			x: 0,
			y: 0,
			heading: 0,
		});
		// Target due south — rudder should be positive (turn right from east heading)
		const tanker = entity({ id: 2, x: 0, y: 1000 });
		const { controls } = host.compute([shahed, tanker], 0.05, 0);
		expect(controls[0].target).toBe(2);
		expect(controls[0].rudder).toBeGreaterThan(0.5);
	});

	it("is jammed near a frigate: flies straight", () => {
		const host = createHost();
		const shahed = entity({
			id: 1,
			type: "shahed",
			faction: "iran",
			airborne: true,
			size: 12,
			behavior: "shahed_intercept",
			bot: botState(),
			x: 0,
			y: 0,
			heading: 0,
		});
		const frigate = entity({
			id: 3,
			type: "frigate",
			faction: "us",
			x: 500,
			y: 0,
			size: 120,
		});
		const tanker = entity({ id: 2, x: 0, y: 1000 });
		const { controls } = host.compute([shahed, frigate, tanker], 0.05, 0);
		expect(controls[0].rudder).toBe(0);
	});
});

describe("quadcopter_intercept behavior", () => {
	it("sticks with a target it shares with a swarm-mate instead of flip-flopping", () => {
		const host = createHost();
		const quad = (id: number, x: number) =>
			entity({
				id,
				type: "quadcopter",
				faction: "iran",
				behavior: "quadcopter_intercept",
				bot: botState({ target: 10 }),
				x,
				y: 0,
				airborne: true,
				size: 2,
			});
		const quads = [quad(1, 0), quad(2, 340)];
		const near = entity({ id: 10, x: 4600, y: 0 });
		const far = entity({ id: 11, x: 0, y: 6200 });

		const targets = new Map<number, number[]>([
			[1, [10]],
			[2, [10]],
		]);
		for (let tick = 0; tick < 40; tick++) {
			const { controls } = host.compute([...quads, near, far], 0.05, tick);
			quads.forEach((q, i) => {
				if (q.bot) q.bot.target = controls[i].target;
				targets.get(q.id)?.push(controls[i].target);
			});
		}
		for (const history of targets.values()) {
			const switches = history.filter((t, i) => i > 0 && t !== history[i - 1]);
			expect(switches.length).toBeLessThanOrEqual(1);
		}
	});
});

describe("escort behavior", () => {
	it("patrols toward a lane anchor when no convoy needs it", () => {
		const host = createHost();
		const frigate = entity({
			id: 1,
			type: "frigate",
			faction: "us",
			behavior: "escort",
			bot: botState(),
			x: 85500,
			y: 40500,
			heading: 0,
			size: 120,
		});
		const { controls, errors } = host.compute([frigate], 0.05, 0);
		expect(errors).toEqual([]);
		expect(controls[0].throttle).toBeCloseTo(0.7);
	});
});

describe("swarm_attack behavior", () => {
	it("flees from a nearby frigate regardless of targets", () => {
		const host = createHost();
		const speedboat = entity({
			id: 1,
			type: "speedboat",
			faction: "iran",
			behavior: "swarm_attack",
			bot: botState(),
			x: 0,
			y: 0,
			heading: 0,
			size: 20,
		});
		const frigate = entity({
			id: 3,
			type: "frigate",
			faction: "us",
			x: 500,
			y: 100,
			size: 120,
		});
		const tanker = entity({ id: 2, x: 0, y: 1000 });
		const { controls } = host.compute([speedboat, frigate, tanker], 0.05, 0);
		// Frigate ahead to starboard; evasion must steer to port (negative)
		expect(controls[0].throttle).toBe(1);
		expect(controls[0].rudder).toBeLessThan(0);
	});

	it("heads home when not in a pack", () => {
		const host = createHost();
		const speedboat = entity({
			id: 1,
			type: "speedboat",
			faction: "iran",
			behavior: "swarm_attack",
			bot: botState({ stamina: 0.1 }),
			x: 60000,
			y: 45000,
			heading: Math.PI / 2,
			size: 20,
		});
		const { controls } = host.compute([speedboat], 0.05, 0);
		// Heading south, the nearest home is east — rudder should turn left (negative)
		expect(controls[0].rudder).toBeLessThan(0);
		expect(controls[0].throttle).toBe(1);
	});
});

describe("danger scent", () => {
	it("attracts spare frigates toward emitted scents", () => {
		const host = createHost();
		host.addScent(5000, 0);
		const frigate = entity({
			id: 1,
			type: "frigate",
			faction: "us",
			behavior: "escort",
			bot: botState(),
			x: 0,
			y: 0,
			heading: 0,
			size: 120,
		});
		const { controls } = host.compute([frigate], 0.05, 0);
		// Scent is dead ahead; patrol anchor pull aside, rudder should be ~0 (straight to scent)
		// and throttle full (danger response)
		expect(controls[0].throttle).toBe(1);
	});

	it("error in one behavior does not kill other entities", () => {
		const host = createHost();
		const broken = entity({
			id: 1,
			behavior: "does_not_exist",
			bot: botState(),
		});
		const tanker = entity({
			id: 2,
			behavior: "tanker_transit",
			bot: botState({ waypoint_index: 2 }),
			x: WP1.x,
			y: WP1.y,
		});
		const { controls, errors } = host.compute([broken, tanker], 0.05, 0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("unknown behavior");
		expect(controls).toHaveLength(2);
		expect(controls[1].throttle).toBeGreaterThan(0);
	});
});

describe("determinism", () => {
	it("identical worlds produce identical outputs", () => {
		const world = [
			entity({
				id: 1,
				behavior: "tanker_transit",
				bot: botState(),
				x: 76227,
				y: 52473,
				heading: 0.5,
			}),
			entity({
				id: 2,
				type: "frigate",
				faction: "us",
				behavior: "escort",
				bot: botState(),
				x: 80000,
				y: 40000,
				size: 120,
			}),
			entity({
				id: 3,
				type: "shahed",
				faction: "iran",
				behavior: "shahed_intercept",
				bot: botState(),
				x: 82000,
				y: 39000,
				airborne: true,
				size: 12,
			}),
		];
		const a = createHost().compute(structuredClone(world), 0.05, 0);
		const b = createHost().compute(structuredClone(world), 0.05, 0);
		expect(a).toEqual(b);
	});
});
