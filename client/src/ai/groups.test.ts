/**
 * Group behavior: convoys, escorts and speedboat packs, observed over
 * simulated time in a TestWorld (real map, client physics, no combat).
 *
 * The browser Lua VM costs a few milliseconds per tick, so scenarios start
 * close to the moment they test: convoys already at sea, prey a few
 * kilometres from the speedboats' base.
 */

import { describe, expect, it } from "vitest";
import { LANE_ALT_OUTBOUND, SPEEDBOAT_SPAWNS } from "../generated/map_data";
import { isLand } from "../map/terrain";
import { TestWorld } from "./test-world";

const SPACING = 700;
const ESCORT_READY_RANGE = 2500;
const HOME_RADIUS = 1500;
const HOLD_RADIUS = 400;
const ATTACK_RANGE = 300;
const SLOW = 60_000;

type Point = { x: number; y: number };

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function centre(points: Point[]): Point {
	return {
		x: points.reduce((s, p) => s + p.x, 0) / points.length,
		y: points.reduce((s, p) => s + p.y, 0) / points.length,
	};
}

/** Tankers waiting at the Gulf end of the outbound route, as they spawn there. */
function anchoredConvoy(world: TestWorld): number[] {
	return [
		{ x: 74000, y: 53800 },
		{ x: 74700, y: 53300 },
		{ x: 73400, y: 54300 },
	].map((p) => world.spawn("oil_tanker", p.x, p.y, { heading: 5.5 }));
}

const [FROM, TO] = [LANE_ALT_OUTBOUND[2], LANE_ALT_OUTBOUND[3]];
const LANE_HEADING = Math.atan2(TO[1] - FROM[1], TO[0] - FROM[0]);

/** A point on the outbound lane, `back` units short of waypoint 3. */
function onLane(back: number, abeam = 0): Point {
	return {
		x: TO[0] - Math.cos(LANE_HEADING) * back - Math.sin(LANE_HEADING) * abeam,
		y: TO[1] - Math.sin(LANE_HEADING) * back + Math.cos(LANE_HEADING) * abeam,
	};
}

/** Tankers already sailing the lane, with these gaps between them. */
function convoyAtSea(world: TestWorld, gaps = [500, 1100]): number[] {
	let back = 300;
	return [0, ...gaps].map((gap) => {
		back += gap;
		const p = onLane(back);
		return world.spawn("oil_tanker", p.x, p.y, {
			heading: LANE_HEADING,
			speed: 12,
			bot: { waypoint_index: 3 },
		});
	});
}

const underWay = (world: TestWorld, ids: number[]) =>
	ids.some((id) => world.vehicle(id).speed > 1);

describe("convoys", () => {
	it(
		"wait at the start of their route while no frigate escorts them",
		() => {
			const world = new TestWorld();
			const tankers = anchoredConvoy(world);
			world.run(20);
			for (const id of tankers)
				expect(world.vehicle(id).speed).toBeLessThan(0.5);
		},
		SLOW,
	);

	it(
		"sail only once their escort is on station",
		() => {
			const world = new TestWorld();
			const tankers = anchoredConvoy(world);
			const anchorage = centre(tankers.map((id) => world.vehicle(id)));
			const frigate = world.spawn("frigate", anchorage.x + 3200, anchorage.y);

			world.runUntil(() => underWay(world, tankers), 120);

			expect(distance(world.vehicle(frigate), anchorage)).toBeLessThan(
				ESCORT_READY_RANGE,
			);
		},
		SLOW,
	);

	it(
		"sail without an escort once they have waited escort_timeout",
		() => {
			const world = new TestWorld();
			world.setConfig("convoy.escort_timeout", 10);
			const tankers = anchoredConvoy(world);
			const waited = world.runUntil(() => underWay(world, tankers), 30);
			expect(waited).toBeGreaterThan(10);
		},
		SLOW,
	);

	it(
		"close up into a column at even spacing",
		() => {
			const world = new TestWorld();
			const tankers = convoyAtSea(world, [400, 1200]);
			world.run(120);
			const ships = tankers.map((id) => world.vehicle(id));
			for (let i = 1; i < ships.length; i++) {
				const gap = distance(ships[i], ships[i - 1]);
				expect(gap).toBeGreaterThan(SPACING * 0.7);
				expect(gap).toBeLessThan(SPACING * 1.4);
			}
		},
		SLOW,
	);
});

describe("escorts", () => {
	it("give every convoy an escort before any convoy gets a second", () => {
		const world = new TestWorld();
		const gulf = anchoredConvoy(world);
		// A second convoy forming at the Oman end, bound for the Gulf.
		const oman = [
			{ x: 92900, y: 61200 },
			{ x: 93500, y: 60600 },
			{ x: 92300, y: 61800 },
		].map((p) =>
			world.spawn("oil_tanker", p.x, p.y, {
				heading: 4.2,
				bot: { destination: "gulf" },
			}),
		);
		// Both frigates start near the Gulf convoy.
		const frigates = [
			world.spawn("frigate", 77880, 51086),
			world.spawn("frigate", 78180, 51086),
		];
		world.run(0.05);

		const assigned = frigates.map((id) => world.bot(id).group).sort();
		const convoys = [world.bot(gulf[0]).group, world.bot(oman[0]).group].sort();
		expect(assigned).toEqual(convoys);
	});

	it(
		"stay with their convoy when another convoy forms nearer to them",
		() => {
			const world = new TestWorld();
			const gulf = anchoredConvoy(world);
			const frigate = world.spawn("frigate", 80000, 49000);
			world.run(0.05);
			const convoy = world.bot(gulf[0]).group;
			expect(world.bot(frigate).group).toBe(convoy);

			const nearer = [0, 1, 2].map((i) =>
				world.spawn("oil_tanker", 79500 + 600 * i, 50500, {
					heading: 4.2,
					bot: { destination: "gulf" },
				}),
			);
			world.run(3);
			expect(world.bot(frigate).group).toBe(convoy);
			expect(world.bot(nearer[0]).group).not.toBe(convoy);
		},
		SLOW,
	);

	it(
		"keep station alongside their convoy at sea",
		() => {
			const world = new TestWorld();
			const tankers = convoyAtSea(world, [700, 700]);
			const start = onLane(1000, -2000);
			const frigate = world.spawn("frigate", start.x, start.y, {
				heading: LANE_HEADING,
				speed: 12,
			});
			const distances: number[] = [];
			world.run(90, () => {
				const f = world.vehicle(frigate);
				distances.push(
					Math.min(...tankers.map((id) => distance(world.vehicle(id), f))),
				);
			});
			const lastHalf = distances.slice(distances.length / 2);
			expect(Math.max(...lastHalf)).toBeLessThan(1500);
		},
		SLOW,
	);

	it(
		"drive at a speedboat closing on their convoy",
		() => {
			const world = new TestWorld();
			const tankers = convoyAtSea(world, [700, 700]);
			const start = onLane(1000, -800);
			const frigate = world.spawn("frigate", start.x, start.y, {
				heading: LANE_HEADING,
				speed: 12,
			});
			world.run(2);
			// A boat 2 km off the far side of the lead ship.
			const lead = world.vehicle(tankers[0]);
			const boat = world.spawn(
				"speedboat",
				lead.x - Math.sin(LANE_HEADING) * 2000,
				lead.y + Math.cos(LANE_HEADING) * 2000,
				{ bot: false },
			);
			const before = distance(world.vehicle(boat), world.vehicle(frigate));
			world.run(15);
			expect(
				distance(world.vehicle(boat), world.vehicle(frigate)),
			).toBeLessThan(before - 300);
		},
		SLOW,
	);
});

describe("speedboat packs", () => {
	const base = SPEEDBOAT_SPAWNS[0];
	const home = { x: base.position[0], y: base.position[1] };
	/** Open water 3 km from the base. */
	const prey = { x: 77813, y: 48376 };

	function boats(world: TestWorld, stamina = 1): number[] {
		return [0, 1].map((i) =>
			world.spawn("speedboat", home.x + 150 * i, home.y, {
				heading: base.heading,
				bot: { stamina },
			}),
		);
	}

	const atHome = (world: TestWorld, id: number) =>
		distance(world.vehicle(id), home) < HOME_RADIUS;

	it(
		"wait at home instead of circling when there is nothing to hunt",
		() => {
			const world = new TestWorld();
			const pack = boats(world);
			world.run(30);
			for (const id of pack) {
				expect(atHome(world, id)).toBe(true);
				expect(Math.abs(world.vehicle(id).speed)).toBeLessThan(1);
			}
		},
		SLOW,
	);

	it(
		"motor back to their base instead of drifting ashore",
		() => {
			// Inside Larak's home radius, coasting slowly toward the island's shore.
			const larak = SPEEDBOAT_SPAWNS[1].position;
			const world = new TestWorld();
			const boat = world.spawn("speedboat", 85600, 39510, {
				heading: 0.27,
				speed: 3,
			});
			let aground = false;
			world.run(60, () => {
				const v = world.vehicle(boat);
				aground ||= isLand(v.x, v.y);
			});
			expect(aground).toBe(false);
			expect(
				distance(world.vehicle(boat), { x: larak[0], y: larak[1] }),
			).toBeLessThan(HOLD_RADIUS);
		},
		SLOW,
	);

	it(
		"go after an unescorted tanker together",
		() => {
			const world = new TestWorld();
			const pack = boats(world);
			const tanker = world.spawn("oil_tanker", prey.x, prey.y, { bot: false });
			const reached = new Set<number>();
			world.runUntil(() => {
				for (const id of pack) {
					if (
						distance(world.vehicle(id), world.vehicle(tanker)) < ATTACK_RANGE
					) {
						reached.add(id);
					}
				}
				return reached.size === pack.length;
			}, 120);
			expect(world.bot(pack[0]).group).not.toBe(0);
			expect(world.bot(pack[0]).group).toBe(world.bot(pack[1]).group);
		},
		SLOW,
	);

	it(
		"leave an escorted tanker alone",
		() => {
			const world = new TestWorld();
			const pack = boats(world);
			world.spawn("oil_tanker", prey.x, prey.y, { bot: false });
			world.spawn("frigate", prey.x + 800, prey.y, { bot: false });
			world.run(20);
			for (const id of pack) {
				expect(world.bot(id).group).toBe(0);
				expect(atHome(world, id)).toBe(true);
			}
		},
		SLOW,
	);

	it(
		"break off together when a frigate closes on their prey",
		() => {
			const world = new TestWorld();
			const pack = boats(world);
			const tanker = world.spawn("oil_tanker", prey.x, prey.y, { bot: false });
			world.runUntil(
				() => distance(world.vehicle(pack[0]), world.vehicle(tanker)) < 2000,
				120,
			);
			world.spawn("frigate", prey.x + 1000, prey.y + 1000, { bot: false });
			world.run(1.5);
			for (const id of pack) expect(world.bot(id).target).toBe(0);
			world.runUntil(() => pack.every((id) => atHome(world, id)), 120);
		},
		SLOW,
	);

	it(
		"rest at home until recharged before hunting again",
		() => {
			const world = new TestWorld();
			const pack = boats(world, 0.4);
			const tanker = world.spawn("oil_tanker", prey.x, prey.y, { bot: false });
			let leftWith = -1;
			world.runUntil(() => {
				const away = pack.find((id) => !atHome(world, id));
				if (away !== undefined) leftWith = world.bot(away).stamina;
				return away !== undefined;
			}, 60);
			expect(leftWith).toBeGreaterThan(0.9);
			expect(world.bot(pack[0]).target).toBe(tanker);
		},
		SLOW,
	);

	it("turn away from a frigate dead ahead", () => {
		const world = new TestWorld();
		const boat = world.spawn("speedboat", 60000, 43000, { speed: 30 });
		world.spawn("frigate", 61000, 43000, { bot: false });
		world.run(0.05);
		expect(Math.abs(world.bot(boat).rudder)).toBeGreaterThan(0.9);
	});
});

describe("group state", () => {
	it(
		"survives the AI VM being rebuilt",
		() => {
			const world = new TestWorld();
			// Use up group id 1, so a VM that lost track would hand out 1 again.
			const dummy = world.spawn("oil_tanker", 60000, 43000);
			world.run(0.05);
			world.remove(dummy);
			const tankers = convoyAtSea(world, [700, 700]);
			const start = onLane(1000, -800);
			const frigate = world.spawn("frigate", start.x, start.y, {
				heading: LANE_HEADING,
				speed: 12,
			});
			world.run(2);
			const convoy = world.bot(tankers[0]).group;
			expect(convoy).toBe(2);
			expect(world.bot(frigate).group).toBe(convoy);

			world.rebuildAI();
			world.run(5);

			for (const id of tankers) {
				expect(world.bot(id).group).toBe(convoy);
				expect(world.vehicle(id).speed).toBeGreaterThan(5);
			}
			expect(world.bot(frigate).group).toBe(convoy);
		},
		SLOW,
	);
});
