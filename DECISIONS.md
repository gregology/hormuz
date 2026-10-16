# Architecture Decisions

Significant architectural decisions with rationale. For early project decisions, see `BRAINSTORM.md`.

---

## 001: Migrate renderer from PixiJS to Three.js

**Date:** 2026-03-30
**Status:** Complete (all 6 phases done)

### Context

The game uses an isometric camera to render naval vehicles, terrain, and effects on a 2D map. PixiJS v8 was chosen initially as a fast, lightweight 2D renderer. As the game grew to include multiple vehicle types at different altitudes (surface ships, drones, helicopters), terrain elevation with hillshade, and complex visual effects, several limitations became painful:

1. **Vehicle sorting artifacts.** Isometric depth sorting via painter's algorithm (`sort((a, b) => a.x + a.y - ...)`) breaks when vehicles overlap at different altitudes. Drones flying over frigates flicker depending on sort order.
2. **No real depth buffer.** Every overlapping element requires manual sort logic. Adding altitude layers (helicopters, dive attacks, submarines) would compound this.
3. **Camera locked to one projection.** Future features (first-person view, free-look per vehicle type) would require reimplementing projection math outside PixiJS.
4. **Occlusion hacks.** Terrain masking uses PixiJS Graphics masks rather than proper depth/stencil operations, which is fragile and slow for complex coastlines.

### Decision

Migrate to Three.js with an OrthographicCamera that produces pixel-identical isometric projection to the existing 2D camera. The migration is phased to keep the game playable throughout:

- **Phase 0:** Three.js scene + camera, validated by tests against existing projection math
- **Phase 1:** Map rendering (water, terrain, coastlines, overlays) on a Three.js canvas behind a transparent PixiJS canvas
- **Phases 2-3:** Vehicle meshes and effects (parallelizable)
- **Phase 4:** HUD moved to DOM overlay
- **Phase 5-6:** Playground migration and PixiJS removal

The migration was completed in 6 phases.

### Rationale

- **Depth buffer solves sorting permanently.** No more manual sort logic or altitude hacks. Vehicles, terrain, and effects all participate in the same depth buffer.
- **True 3D meshes.** Vehicle models (currently defined as block geometry) can be extruded into real 3D objects with correct face shading. New vehicle types with complex shapes become straightforward.
- **Camera flexibility.** OrthographicCamera for isometric, PerspectiveCamera for first-person or chase cam. Switching is a camera swap, not a renderer rewrite.
- **Stencil buffer for terrain masking.** Replaces fragile PixiJS Graphics masks with standard GPU stencil operations.
- **Shaders are ~95% portable.** The existing water and terrain fragment shaders are pure GLSL math. Only the vertex shader and `vColor` multiply needed changes.

### What doesn't change

Game logic, networking, input, physics, collision, map data, and all server code are renderer-agnostic and require zero modifications. The rendering boundary is clean.

### Risks

1. Camera projection alignment (mitigated: Phase 0 tests verify pixel-identical projection)
2. Wake trail fidelity in Three.js (WebGL line width limitations)
3. Dual-canvas performance during transition (temporary, acceptable)

---

## 002: Force-based vehicle physics with propeller torque steering and progressive flooding

**Date:** 2026-03-30
**Status:** Complete (all 4 phases done)

### Context

The original physics model used explicit `maxSpeed`, linear `acceleration`, and exponential `drag` with direct heading changes from rudder input. This was a serviceable abstraction but didn't model the physical reality of naval propulsion — engine power, water resistance, and how rudders actually work (deflecting propeller wash at the stern to create torque).

### Decision

Replace the velocity-based model with a staged 4-phase overhaul:

- **Phase 1 — Engine power + quadratic drag.** Replace `maxSpeed`/`acceleration`/`drag` with `enginePower`/`dragCoefficient`/`mass`. Top speed emerges from thrust-drag equilibrium (`v_max = √(enginePower / dragCoefficient)`).
- **Phase 2 — Propeller torque steering.** For ships, rudder deflects the thrust vector at the propeller (stern). The lateral force component creates torque → angular velocity → heading change. Stern kick, speed-dependent turn rate, and throttle-dependent steering all emerge naturally. Non-ship vehicles (trucks, drones) keep direct `turnRate` steering. Ships with conventional rudders (frigate, tanker) also steer from water flow at speed via `rudderFlowCoefficient`; outboard-steered vessels (speedboat) need throttle to turn.
- **Phase 3 — Progressive flooding.** Hull breaches cause water ingress → listing → sinking. Asymmetric damage produces list angle (roll toward damaged side). Flooding increases drag (ship slows) and draft (ship rides lower). Shahed-tanker combat creates breaches instead of instant kills.
- **Phase 4 — Server port.** Python server physics matches client. Snapshot protocol extended with `flood_level` and `list_angle`.

Each phase was developed and tuned in the playground, validated by tests, then ported to the server.

### Rationale

- **Emergent behavior over parameterized behavior.** Turn rate, top speed, and stern kick all fall out of the force model rather than being magic numbers.
- **Physical intuition guides tuning.** "More engine power" and "heavier ship" are intuitive; "exponential drag coefficient 0.97" is not.
- **Progressive flooding adds drama.** Ships list and slow before sinking, visible to all players. Much more impactful than binary alive/dead.
- **Staged migration reduced risk.** Each phase was testable and revertible independently.

---

## 003: Shared Lua AI — one behavior source embedded in both hosts

**Date:** 2026-07-16
**Status:** Complete

### Context

Bot AI lived only in the Python server (`systems/bot_ai.py`, `danger_scent.py`, `threat_picture.py`, ~1,100 lines). The playground — the project's primary development tool — had no AI at all, so emergent behavior (escort formations, wolf-pack attacks, danger responses) could only be observed by booting the full server. The obvious fix (port the AI to TypeScript for the playground) would create two implementations that drift, the same risk the project already carries for physics (`physics.ts` ↔ `physics.py`). Sharing via a single package is blocked by the language barrier: the server is Python, the playground is a browser. Alternatives considered: TS package + Node sidecar (runtime fragility in a 24/7 game), Rust dual-target (third toolchain, slowest iteration loop), YAML behavior DSL (drift moves into two interpreters with worse tooling), dual implementation + golden tests (parity work forever).

### Decision

Write the AI once in **Lua**, embedded in both hosts:

- **`shared/ai/`** — `config.lua` (all tunables), `lib/steering.lua` (primitives + pressure-scored target selection + waypoint following), `behaviors/*.lua` (tanker_transit, escort, swarm_attack, shahed_intercept, quadcopter_intercept), `main.lua` (dispatch, danger scent, threat picture, collision-avoidance post-pass, pcall isolation per entity).
- **Browser host:** `client/src/ai/lua-host.ts` embeds the scripts via fengari (pure-JS Lua VM), bundled with `import.meta.glob`. Used by the playground (per-vehicle AI toggle, master switch, lil-gui sliders bound live to `config.lua`).
- **Server host:** `server/src/hormuz/systems/ai_bridge.py` embeds the same scripts via lupa (Lua 5.5). `systems/bot_ai.py` is now a thin esper adapter; `physics.py` routes the player tanker autopilot through the same Lua waypoint follower; `combat.py` emits danger scents into the VM. The bridge hot-reloads the VM when scripts change on disk (~3s poll).
- **Host contract:** both hosts inject an `ai.gamedata` module (lanes, routes, exclusion zones, spawn points, detection ranges — all derived from generated YAML data) and a global `is_land(x, y)`. Bot state (target, waypoint index, stamina) persists in the hosts (`BotControl` esper component / playground state), so VM rebuilds lose nothing but danger scents (which decay within 60s anyway).
- **Parity testing:** `shared/ai/contract_fixtures.json` pins tick-by-tick control outputs for 7 scenarios. Vitest runs them through fengari (`client/src/ai/contract.test.ts`), pytest through lupa (`server/tests/test_ai_contract.py`). Regenerate with `UPDATE_AI_FIXTURES=1 pnpm --filter @hormuz/client test -- contract` after intentional behavior changes, then run server tests to confirm hosts still agree.

### Rationale

- **Single source of truth.** Behaviors are authored once; drift between server and playground is impossible by construction.
- **Hot reload everywhere.** Scripts are data — the playground picks up edits instantly (Vite reload) and the server reloads the VM without dropping connections, which matters for a 24/7 persistent game.
- **Iteration speed where it matters.** AI rules are the hottest tuning loop in the project; editing a Lua file beats editing two languages or recompiling WASM.
- **Extensibility for future tooling.** Headless behavior tests run in Vitest against scripted scenarios; the same host can serve replay analysis or balance sims later.
- **Industry-proven pattern.** Embedding Lua for game logic (WoW, Factorio, Roblox) is the standard solution to exactly this problem.

### Costs accepted

- **Third language in the repo.** Lua is deliberately small; `lua-language-server` + EmmyLua annotations give real IDE support.
- **Two Lua runtimes** (fengari = Lua 5.3 semantics, lupa = Lua 5.5). Scripts stick to the common subset; the `math.atan2` compat shim in `lib/steering.lua` is the canonical example. Contract tests catch any residual float/semantic drift.
- **Runtime hardening is the project's job.** Every behavior call is wrapped in `pcall`; errors are isolated per entity and surfaced (playground AI panel, server logs) without killing the tick.
- **lupa quirks discovered during integration:** `table_from(recursive=True)` breaks on objects referenced twice in one structure (lanes/routes each get their own copies), and Lua 5.5's preload searcher rejects non-Lua callables (gamedata loader is wrapped in a Lua function).
- **fengari assumes Node:** its CJS entry reads `process.env.FENGARICONF` at module load and its io/os libraries touch `process.stdin`/`fs`/`tmp`. The Vite configs shim `process.env`/`process.versions.node` via `define`, and the hosts open only the libraries the sandbox needs (base, package, table, string, math) instead of `luaL_openlibs` — the lupa side removes the same globals for parity.

---

## 004: WebGPU renderer with TSL node materials, real-time lighting, and data-driven ship models

**Date:** 2026-10-15
**Status:** Complete

### Context

The game looked like a diagram: every surface was a hand-picked flat colour (vehicle blocks used three fixed shades), with no lights, shadows, sky or reflections. The sea was sine-wave stripes and the land a flat polygon with a painted hillshade, even though land vehicles were placed at their 3D elevation (so any real shadow would have landed far from them). Custom `ShaderMaterial`s skipped colour management and tone mapping, and `logarithmicDepthBuffer` ruled out three's depth-based effects. The README already called for time of day to follow the real strait.

Three approaches were proposed: (A) add real lighting within `WebGLRenderer`, splicing three's lighting chunks into every custom GLSL shader; (B) keep all-custom GLSL with a shared hand-written lighting include and faked shadows; (C) move to three's `WebGPURenderer` with TSL node materials. C was chosen as the most extensible.

### Decision

- **Renderer:** `WebGPURenderer` (automatic WebGL2 fallback, `?webgl` to force). Every custom shader is now a TSL node graph; built-in materials are converted automatically. `THREE.RenderPipeline` does bloom, ACES tone mapping and a vignette. `logarithmicDepthBuffer` is kept (it works on both backends; reversed depth would silently break on WebGL2 without `EXT_clip_control`). Quality tiers scale shadows/bloom/MSAA/pixel ratio.
- **Time of day:** sun position from UTC at the strait (`solar.ts`, NOAA approximation), mapped to an art-directed palette (`daylight.ts`). `Environment` drives sun, moon, hemisphere ambient, a physical sky (clamped: its sun disc overflows half-float buffers into NaNs) for the perspective background and pre-filtered sea reflections, view-fitted texel-snapped shadows, and horizon fog. Ship windows and navigation lights glow after dusk.
- **Sea:** one lit plane coloured by real bathymetry (new `BATHYMETRY_DATA` from the heightmap generator, rendering only), a coast signed distance field (`map/coast-field.ts`), scrolling procedural wave normals, surf on every shore/rock/shoal, and footprint-dependent roughness so sub-pixel waves become glitter rather than aliasing.
- **Land:** a displaced terrain mesh (reverses 001's hillshade sprite), clipped per pixel at the coastline polygons via the coast field, eased to sea level near the coast so the shoreline stays put. Shading uses exaggerated normals plus NW–SE fold ridges in the mountains.
- **Vehicles:** models are pure data — lofted hulls plus parts — merged into one geometry per shape, with paint in vertex attributes and palette slots as per-object uniforms, so every vehicle shares one material and costs one draw call. Tankers get deterministic designs per entity id (four classes, varied liveries). Faction moved from hull paint to IFF rings with a minimum screen size.
- **Effects:** sized particles are instanced sprites (`ParticleBatch`; WebGPU has no point size) in three shared batches. New: damage smoke and fire, bow waves, explosion fireballs/shockwaves/spray, sinking wrecks that use the real model and go under the opaque sea.

### Rationale

- **Lighting is free for custom materials.** A TSL material only describes its surface; lights, shadows, fog, environment and log depth apply automatically. Under A, every new effect would have repeated the chunk-splicing.
- **Composable shading.** Node graphs are type-checked TypeScript and reusable (e.g. the shared vehicle material, per-object palette uniforms).
- **Headroom.** Compute, SSR/GTAO/TRAA nodes are available when wanted; three's development is centred here.
- **Gameplay stays readable.** IFF rings keep factions legible when zoomed out, and night is moonlit rather than black.

### Costs accepted

- **A rewrite before any visual gain.** All ~12 GLSL shaders were ported; `ShaderMaterial` can no longer be used.
- **TSL churn.** The API still moves between releases (`PostProcessing` became `RenderPipeline` in r183); three upgrades may need shader fixes.
- **Async startup.** `ThreeScene.create()` must be awaited; long first frames (shader compilation) made the playground's camera follow diverge, so its frame delta is now clamped.
- **Bigger bundle.** The client bundle is ~1.2 MB (330 KB gzip) with three's WebGPU build.
- **Visual-only height mismatch near coasts.** Within 300 units of the coast the rendered terrain sits slightly below the gameplay heightmap; physics is unchanged.

---

## 005: Snapshot playback on the server tick timeline

**Date:** 2026-10-15
**Status:** Complete

### Context

Fast vehicles looked jittery, most visibly with the camera locked to a shahed or quadcopter. The client stamped each snapshot with its arrival time and rendered a fixed 100 ms behind, but the server advances exactly one tick between snapshots — arrival times carry the noise of the server loop, the network, TCP retransmits and the browser's main thread. Replaying recorded snapshots at 60 fps measured 8% frame-to-frame speed wobble on an idle localhost, 18% with 40 clients connected, ~28% with modelled internet jitter, and a freeze-then-jump whenever a gap exceeded 100 ms. Alternatives considered: client-side prediction of the player's own vehicle (needs `physics.ts` ↔ `physics.py` parity and a protocol change; can be layered on later), extrapolation (wrong exactly when drones turn or collide), and a higher tick rate (shrinks the gaps without fixing the timestamps, and multiplies bandwidth).

### Decision

- Snapshots are keyed by server time (`tick / TICK_RATE`). `SnapshotInterpolator` only interpolates; it no longer applies a delay of its own.
- **`PlaybackClock`** (`client/src/game/playback-clock.ts`) decides which server time to render each frame. Over the last 6 s of arrivals it measures the server's pace (from the least-delayed snapshots, so late bursts can't skew it) and the spread of lateness, and aims just far enough behind that every recent snapshot would have arrived in time (covering up to 0.2 s of jitter). It reaches that target by playing up to 5% faster or slower, never runs past the newest snapshot (late data holds playback rather than jumping), skips ahead after an outage, and starts a new timeline if the tick counter goes backwards.
- `TICK_RATE` moved to `shared/vehicles.yaml` (`world.tick_rate`) and is generated for both hosts.

### Rationale

- **Fixes the cause for every entity**, not only the player's vehicle. No protocol change: snapshots already carried the tick.
- **Measured:** the same recordings replay with 0.9% wobble on localhost, 3% under load and ~6% with modelled internet jitter, with no jumps.
- **Testable in isolation.** A pure module; `playback-clock.test.ts` streams a vehicle through simulated networks (jitter, a slow server, an outage, a restart) and checks what reaches the screen, plus a property test that playback never runs backwards or past the newest snapshot.
- **A shared timeline to build on.** Game events can carry a tick and play at the right moment, and client-side prediction can reconcile against the same clock.

### Costs accepted

- **Latency follows the connection:** ~65 ms behind the newest snapshot on a clean link (previously a fixed ~75 ms), ~130 ms on a jittery one. Input still takes a round trip plus this buffer to show on screen; prediction would remove that.
- **Slow recovery after outages.** After an outage longer than ~0.25 s, playback stays up to ~0.28 s behind for ~10 s while the burst of late snapshots ages out of the window.
- **Server-side jitter remains.** The relative-sleep tick loop, input sent every frame and a broadcast that waits on slow clients still cause gaps; the clock hides them only up to the size of its buffer.
