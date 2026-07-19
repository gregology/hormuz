// Minimal typings for the fengari subset used by the AI host.
// fengari ships no TypeScript declarations.

declare module "fengari" {
	export type LuaState = object;
	export type LuaFunction = (L: LuaState) => number;

	export const lua: {
		LUA_OK: number;
		LUA_TNIL: number;
		LUA_TNUMBER: number;
		LUA_TSTRING: number;
		LUA_TBOOLEAN: number;
		LUA_TTABLE: number;
		LUA_TFUNCTION: number;
		lua_gettop(L: LuaState): number;
		lua_settop(L: LuaState, idx: number): void;
		lua_pop(L: LuaState, n: number): void;
		lua_absindex(L: LuaState, idx: number): number;
		lua_type(L: LuaState, idx: number): number;
		lua_typename(L: LuaState, tp: number): string;
		lua_getglobal(L: LuaState, name: Uint8Array): number;
		lua_setglobal(L: LuaState, name: Uint8Array): void;
		lua_getfield(L: LuaState, idx: number, k: Uint8Array): number;
		lua_setfield(L: LuaState, idx: number, k: Uint8Array): void;
		lua_createtable(L: LuaState, narr?: number, nrec?: number): void;
		lua_rawseti(L: LuaState, idx: number, n: number): void;
		lua_next(L: LuaState, idx: number): number;
		lua_pushnil(L: LuaState): void;
		lua_pushnumber(L: LuaState, n: number): void;
		lua_pushstring(L: LuaState, s: Uint8Array): void;
		lua_pushboolean(L: LuaState, b: boolean): void;
		lua_pushjsfunction(L: LuaState, f: LuaFunction): void;
		lua_pcall(
			L: LuaState,
			nargs: number,
			nresults: number,
			msgh: number,
		): number;
		lua_error(L: LuaState): number;
		lua_tonumberx(L: LuaState, idx: number, isnum: null): number;
		lua_toboolean(L: LuaState, idx: number): boolean;
		lua_tostring(L: LuaState, idx: number): Uint8Array;
		lua_isinteger(L: LuaState, idx: number): boolean;
	};

	export const lauxlib: {
		luaL_newstate(): LuaState;
		luaL_loadstring(L: LuaState, s: Uint8Array): number;
		luaL_dostring(L: LuaState, s: Uint8Array): number;
		luaL_requiref(
			L: LuaState,
			modname: Uint8Array,
			openf: LuaFunction,
			glb: number,
		): void;
	};

	export const lualib: {
		luaL_openlibs(L: LuaState): void;
		luaopen_base(L: LuaState): number;
		luaopen_package(L: LuaState): number;
		luaopen_table(L: LuaState): number;
		luaopen_string(L: LuaState): number;
		luaopen_math(L: LuaState): number;
	};

	export function to_luastring(s: string): Uint8Array;
	export function to_jsstring(s: Uint8Array): string;
}
