/**
 * Must be imported BEFORE fengari (import order matters — ESM evaluates
 * dependencies in import order, so this runs before fengari's module body).
 *
 * fengari's luaconf.js picks its code path from `typeof process`: browser
 * when undefined, Node otherwise. Some browser environments (extensions,
 * userscripts, polyfills) define a global `process`, sending luaconf down
 * the Node branch where it calls `require('os').platform()` — which Vite
 * can only stub. Removing the global forces the browser branch.
 *
 * In Node (vitest, tooling) the global is legitimate and left alone —
 * luaconf takes the Node branch and the real `os` module works fine.
 */
if (typeof window !== "undefined" && typeof document !== "undefined") {
	const g = globalThis as { process?: unknown };
	try {
		delete g.process;
	} catch {
		g.process = undefined;
	}
}

export {};
