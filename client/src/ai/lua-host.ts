/**
 * Lua AI host — runs the shared behavior scripts (shared/ai) inside a fengari
 * VM embedded in the browser.
 *
 * The Python server hosts the same scripts via lupa (systems/ai_bridge.py).
 * Both hosts implement the same contract:
 *   - module preloads under "ai.*" names (ai.main, ai.config, ai.lib.*, ai.behaviors.*)
 *   - an "ai.gamedata" module returning static map/vehicle data
 *   - a global is_land(x, y) terrain query
 *   - globals ai_compute(world) -> (controls, errors), ai_add_scent, ai_get/set_config
 *
 * The VM is deterministic given identical inputs, which the cross-host
 * contract tests rely on.
 */

import "./fengari-preload";
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from "fengari";
import type { LuaFunction, LuaState } from "fengari";

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

export interface AIGameData {
	lanes: { outbound: [number, number][]; inbound: [number, number][] };
	routes: Record<string, { route: [number, number][]; exit: [number, number] }>;
	strait_center: [number, number];
	exclusion_zones: {
		name: string;
		polygon: [number, number][];
		behaviors: string[];
	}[];
	speedboat_homes: [number, number][];
	detection_ranges: Record<string, Record<string, number>>;
	jam_radius: number;
}

export interface AIBotState {
	throttle: number;
	rudder: number;
	stamina: number;
	waypoint_index: number;
	target: number;
	destination: string;
}

export interface AIEntitySnapshot {
	id: number;
	type: string;
	faction: string;
	x: number;
	y: number;
	heading: number;
	speed: number;
	hp: number;
	airborne: boolean;
	size: number;
	/** Behavior name for AI-controlled entities; omit for players/passive entities. */
	behavior?: string;
	/** Live bot state, required when behavior is set. */
	bot?: AIBotState;
}

export interface AIControlOutput {
	id: number;
	throttle: number;
	rudder: number;
	target: number;
	waypoint_index: number;
	stamina: number;
}

export interface AIFrameResult {
	controls: AIControlOutput[];
	errors: string[];
}

export interface LuaAIHostOptions {
	isLand: (x: number, y: number) => boolean;
	gameData: AIGameData;
}

// ---------------------------------------------------------------------------
// Script sources — bundled at build time from shared/ai
// ---------------------------------------------------------------------------

const LUA_SCRIPT_SOURCES = import.meta.glob("../../../shared/ai/**/*.lua", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

function moduleNameFor(path: string): string {
	const match = /shared\/(.+)\.lua$/.exec(path);
	if (!match) throw new Error(`unexpected AI script path: ${path}`);
	return match[1].replaceAll("/", ".");
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export class LuaAIHost {
	private readonly L: LuaState;
	private readonly isLand: (x: number, y: number) => boolean;

	constructor(options: LuaAIHostOptions) {
		this.isLand = options.isLand;
		this.L = lauxlib.luaL_newstate();
		// Open only the libraries the AI sandbox needs. io/os/debug are
		// node-coupled in fengari (process.stdin etc. at open time) and
		// unwanted in a behavior sandbox anyway. The lupa host removes the
		// same globals for parity.
		const libs: [string, LuaFunction][] = [
			["_G", lualib.luaopen_base],
			["package", lualib.luaopen_package],
			["table", lualib.luaopen_table],
			["string", lualib.luaopen_string],
			["math", lualib.luaopen_math],
		];
		for (const [name, openf] of libs) {
			lauxlib.luaL_requiref(this.L, to_luastring(name), openf, 1);
			lua.lua_pop(this.L, 1);
		}

		for (const [path, source] of Object.entries(LUA_SCRIPT_SOURCES)) {
			// preload[name] = the chunk itself; require calls it and caches its result
			this.registerScript(moduleNameFor(path), source);
		}
		this.registerPreload("ai.gamedata", () => {
			this.pushValue(options.gameData);
			return 1;
		});

		lua.lua_pushjsfunction(this.L, (L) => {
			const x = lua.lua_tonumberx(L, 1, null);
			const y = lua.lua_tonumberx(L, 2, null);
			lua.lua_pushboolean(L, this.isLand(x, y));
			return 1;
		});
		lua.lua_setglobal(this.L, to_luastring("is_land"));

		const status = lauxlib.luaL_dostring(
			this.L,
			to_luastring(`
				local main = require("ai.main")
				function ai_compute(world) return main.compute_controls(world) end
				function ai_add_scent(x, y) main.add_scent(x, y) end
				function ai_get_config() return main.get_config_flat() end
				function ai_set_config(path, value) return main.set_config(path, value) end
			`),
		);
		if (status !== lua.LUA_OK) {
			const msg = to_jsstring(lua.lua_tostring(this.L, -1));
			throw new Error(`failed to load AI scripts: ${msg}`);
		}
		lua.lua_settop(this.L, 0);
	}

	/** Run one AI tick. Entities are sorted by id for deterministic behavior ordering. */
	compute(
		entities: AIEntitySnapshot[],
		dt: number,
		time: number,
	): AIFrameResult {
		const L = this.L;
		const top = lua.lua_gettop(L);
		try {
			lua.lua_getglobal(L, to_luastring("ai_compute"));
			const sorted = [...entities].sort((a, b) => a.id - b.id);
			this.pushValue({ time, dt, entities: sorted });
			this.callChecked(1, 2, "ai_compute");
			const controls = this.readValue(-2) as AIControlOutput[];
			const errors = this.readValue(-1) as string[];
			return { controls, errors };
		} finally {
			lua.lua_settop(L, top);
		}
	}

	/** Record a danger event (attack, sinking) at this location. */
	addScent(x: number, y: number): void {
		const L = this.L;
		const top = lua.lua_gettop(L);
		try {
			lua.lua_getglobal(L, to_luastring("ai_add_scent"));
			lua.lua_pushnumber(L, x);
			lua.lua_pushnumber(L, y);
			this.callChecked(2, 0, "ai_add_scent");
		} finally {
			lua.lua_settop(L, top);
		}
	}

	/** Flat config view for dev panels: { "tanker.brake_range": 400, ... } */
	getConfigFlat(): Record<string, number> {
		const L = this.L;
		const top = lua.lua_gettop(L);
		try {
			lua.lua_getglobal(L, to_luastring("ai_get_config"));
			this.callChecked(0, 1, "ai_get_config");
			return this.readValue(-1) as Record<string, number>;
		} finally {
			lua.lua_settop(L, top);
		}
	}

	setConfig(path: string, value: number): void {
		const L = this.L;
		const top = lua.lua_gettop(L);
		try {
			lua.lua_getglobal(L, to_luastring("ai_set_config"));
			lua.lua_pushstring(L, to_luastring(path));
			lua.lua_pushnumber(L, value);
			this.callChecked(2, 1, "ai_set_config");
		} finally {
			lua.lua_settop(L, top);
		}
	}

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	private registerScript(name: string, source: string): void {
		const L = this.L;
		lua.lua_getglobal(L, to_luastring("package"));
		lua.lua_getfield(L, -1, to_luastring("preload"));
		if (lauxlib.luaL_loadstring(L, to_luastring(source)) !== lua.LUA_OK) {
			const msg = to_jsstring(lua.lua_tostring(L, -1));
			throw new Error(`failed to compile ${name}: ${msg}`);
		}
		lua.lua_setfield(L, -2, to_luastring(name));
		lua.lua_pop(L, 2);
	}

	private registerPreload(name: string, loader: LuaFunction): void {
		const L = this.L;
		lua.lua_getglobal(L, to_luastring("package"));
		lua.lua_getfield(L, -1, to_luastring("preload"));
		lua.lua_pushjsfunction(L, loader);
		lua.lua_setfield(L, -2, to_luastring(name));
		lua.lua_pop(L, 2);
	}

	private callChecked(nargs: number, nresults: number, what: string): void {
		if (lua.lua_pcall(this.L, nargs, nresults, 0) !== lua.LUA_OK) {
			const msg = to_jsstring(lua.lua_tostring(this.L, -1));
			throw new Error(`${what} failed: ${msg}`);
		}
	}

	private pushValue(value: unknown): void {
		const L = this.L;
		if (value === null || value === undefined) {
			lua.lua_pushnil(L);
		} else if (typeof value === "number") {
			lua.lua_pushnumber(L, value);
		} else if (typeof value === "string") {
			lua.lua_pushstring(L, to_luastring(value));
		} else if (typeof value === "boolean") {
			lua.lua_pushboolean(L, value);
		} else if (Array.isArray(value)) {
			lua.lua_createtable(L, value.length, 0);
			for (let i = 0; i < value.length; i++) {
				this.pushValue(value[i]);
				lua.lua_rawseti(L, -2, i + 1);
			}
		} else if (typeof value === "object") {
			const entries = Object.entries(value);
			lua.lua_createtable(L, 0, entries.length);
			for (const [k, v] of entries) {
				this.pushValue(v);
				lua.lua_setfield(L, -2, to_luastring(k));
			}
		}
	}

	private readValue(idx: number): unknown {
		const L = this.L;
		switch (lua.lua_type(L, idx)) {
			case lua.LUA_TNIL:
				return null;
			case lua.LUA_TBOOLEAN:
				return lua.lua_toboolean(L, idx);
			case lua.LUA_TNUMBER:
				return lua.lua_tonumberx(L, idx, null);
			case lua.LUA_TSTRING:
				return to_jsstring(lua.lua_tostring(L, idx));
			case lua.LUA_TTABLE:
				return this.readTable(idx);
			default:
				return null;
		}
	}

	private readTable(idx: number): unknown {
		const L = this.L;
		const absIdx = lua.lua_absindex(L, idx);
		const obj: Record<string, unknown> = {};
		let isArray = true;
		let maxIndex = 0;
		lua.lua_pushnil(L);
		while (lua.lua_next(L, absIdx) !== 0) {
			if (lua.lua_type(L, -2) === lua.LUA_TNUMBER) {
				const k = lua.lua_tonumberx(L, -2, null);
				obj[String(k - 1)] = this.readValue(-1);
				maxIndex = Math.max(maxIndex, k);
			} else {
				isArray = false;
				const k = to_jsstring(lua.lua_tostring(L, -2));
				obj[k] = this.readValue(-1);
			}
			lua.lua_pop(L, 1);
		}
		if (isArray) {
			const arr: unknown[] = [];
			for (let i = 0; i < maxIndex; i++) arr.push(obj[String(i)]);
			return arr;
		}
		return obj;
	}
}
