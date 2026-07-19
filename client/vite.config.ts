import { defineConfig } from "vitest/config";

// fengari's CJS entry reads process.env.FENGARICONF (luaconf.js) and
// process.versions.node (liolib.js) at module load; there is no process
// global in the browser, so stub them out.
const processEnvShim = { "process.env": "{}", "process.versions.node": "18" };

export default defineConfig({
	define: processEnvShim,
	optimizeDeps: {
		esbuildOptions: {
			define: processEnvShim,
		},
	},
	server: {
		port: 3000,
		proxy: {
			"/ws": {
				target: "ws://localhost:8000",
				ws: true,
			},
			"/api": {
				target: "http://localhost:8000",
			},
		},
	},
	build: {
		target: "ES2022",
	},
	test: {
		include: ["src/**/*.test.ts"],
	},
});
