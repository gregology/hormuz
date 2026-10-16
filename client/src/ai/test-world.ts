/**
 * A small headless world for AI behavior tests: the shared Lua AI drives
 * vehicles through the client physics (vehicles/physics.ts) over the real
 * map, one server tick at a time. There is no combat or vehicle collision,
 * so tests see what the bots decide and how they move, nothing else.
 */

import {
	MAX_HP,
	TICK_RATE,
	VEHICLES,
	type VehicleType,
} from "../generated/vehicles";
import { isLand } from "../map/terrain";
import {
	type NavalVehicle,
	createVehicle,
	updateVehicle,
} from "../vehicles/physics";
import { buildClientGameData } from "./game-data";
import { type AIBotState, type AIEntitySnapshot, LuaAIHost } from "./lua-host";

const TICK = 1 / TICK_RATE;

interface WorldEntity {
	vehicle: NavalVehicle;
	faction: string;
	hp: number;
	behavior?: string;
	bot?: AIBotState;
}

export interface SpawnOptions {
	heading?: number;
	speed?: number;
	/** Bot state overrides; pass `false` for a passive vehicle no AI controls. */
	bot?: Partial<AIBotState> | false;
}

export class TestWorld {
	time = 0;
	private host = TestWorld.newHost();
	private readonly entities = new Map<number, WorldEntity>();
	private nextId = 1;

	private static newHost(): LuaAIHost {
		return new LuaAIHost({ isLand, gameData: buildClientGameData() });
	}

	spawn(
		type: VehicleType,
		x: number,
		y: number,
		options: SpawnOptions = {},
	): number {
		const id = this.nextId++;
		const vehicle = createVehicle(type, x, y);
		vehicle.heading = options.heading ?? 0;
		vehicle.speed = options.speed ?? 0;
		const definition = VEHICLES[type];
		const entity: WorldEntity = {
			vehicle,
			faction: definition.faction,
			hp: MAX_HP[type],
		};
		if (options.bot !== false) {
			entity.behavior = definition.aiBehavior;
			entity.bot = {
				throttle: 0,
				rudder: 0,
				stamina: 1,
				waypoint_index: 0,
				target: 0,
				destination: "oman",
				group: 0,
				...options.bot,
			};
		}
		this.entities.set(id, entity);
		return id;
	}

	remove(id: number): void {
		this.entities.delete(id);
	}

	vehicle(id: number): NavalVehicle {
		return this.entity(id).vehicle;
	}

	bot(id: number): AIBotState {
		const bot = this.entity(id).bot;
		if (!bot) throw new Error(`entity ${id} is not a bot`);
		return bot;
	}

	setConfig(path: string, value: number): void {
		this.host.setConfig(path, value);
	}

	/** Replace the Lua VM, as the server does when scripts change on disk. */
	rebuildAI(): void {
		this.host = TestWorld.newHost();
	}

	/** Advance `seconds`, calling `each` after every tick. */
	run(seconds: number, each: () => void = () => {}): void {
		const ticks = Math.round(seconds * TICK_RATE);
		for (let i = 0; i < ticks; i++) {
			this.tick();
			each();
		}
	}

	/** Advance until `done` holds (checked after every tick), or fail after `limit` seconds. */
	runUntil(done: () => boolean, limit: number): number {
		const start = this.time;
		while (!done()) {
			if (this.time - start >= limit) {
				throw new Error(`condition not met within ${limit} s`);
			}
			this.tick();
		}
		return this.time - start;
	}

	private tick(): void {
		this.time += TICK;
		const snapshots: AIEntitySnapshot[] = [];
		for (const [id, e] of this.entities) {
			const v = e.vehicle;
			snapshots.push({
				id,
				type: v.vehicleType,
				faction: e.faction,
				x: v.x,
				y: v.y,
				heading: v.heading,
				speed: v.speed,
				hp: e.hp,
				airborne: v.airborne,
				size: v.size,
				...(e.bot ? { behavior: e.behavior, bot: e.bot } : {}),
			});
		}
		const { controls, errors } = this.host.compute(snapshots, TICK, this.time);
		if (errors.length > 0) throw new Error(errors.join("; "));
		for (const c of controls) {
			const bot = this.entities.get(c.id)?.bot;
			if (!bot) continue;
			bot.throttle = c.throttle;
			bot.rudder = c.rudder;
			bot.target = c.target;
			bot.waypoint_index = c.waypoint_index;
			bot.stamina = c.stamina;
			bot.group = c.group;
		}
		for (const e of this.entities.values()) {
			const controls = e.bot ?? { throttle: 0, rudder: 0 };
			updateVehicle(e.vehicle, controls, TICK);
		}
	}

	private entity(id: number): WorldEntity {
		const e = this.entities.get(id);
		if (!e) throw new Error(`no entity ${id}`);
		return e;
	}
}
