# AGENTS.md

Guidelines for AI agents and human contributors working on Hormuz.

## Project Context

Hormuz is a persistent multiplayer anti-war browser game. Players control military vehicles, civilian oil tankers, and autonomous weapons in the Strait of Hormuz. The game runs 24/7 with ~140 bots and up to 200 concurrent humans. See `README.md` for the full design document and `BRAINSTORM.md` for early decisions.

**Stack:** TypeScript + Three.js (client renderer), Python 3.12+ + FastAPI + esper ECS (server), WebSocket + MessagePack (networking), YAML + codegen (shared types), Lua (shared AI behaviors — see DECISIONS.md 003).

## Core Principle: Optimize for Maintainability and Extensibility

Every decision — architecture, code style, testing, tooling — is evaluated against two questions:

1. **Can this be changed easily later?** Code that resists change is a liability. Prefer designs that are simple to modify, even if they require more upfront thought.
2. **Can a new feature be added without rewriting existing code?** The game will grow to 11+ vehicle types, multiple weapon systems, AI behaviors, and visual effects. Adding a new vehicle should be a data definition + sprite + AI behavior, not a rewrite.

Do not shy away from larger refactors if the result is a more maintainable codebase. A clean refactor now saves compounding complexity later. The test suite exists specifically to make refactors safe and confident.

## When to Act vs When to Propose

### Act autonomously when

- Fixing a bug with a clear root cause
- Implementing a feature within an established pattern (e.g., adding a new vehicle type using the existing YAML + codegen pipeline)
- Refactoring code to match an existing pattern already used elsewhere in the codebase
- Writing or updating tests
- Fixing lint/format/type errors

### Stop and propose when introducing a new pattern or architecture

When the work requires a new architectural pattern, coding convention, or design approach that doesn't already exist in the codebase:

1. **Research** the problem and current best practices
2. **Propose 2-3 approaches** to the human, each with:
   - **Summary:** What the approach is in plain language
   - **Pros:** Where it excels
   - **Cons:** Where it falls short
   - **Extensibility:** How well it supports future features
   - **Maintainability:** How easy it is to understand and modify
   - **Testability:** How naturally it can be tested at the right level
   - **Elegance:** How clean and minimal the solution is
3. **Wait for a decision** before implementing

Examples of when to propose:

- Introducing a state management pattern
- Choosing how to structure AI behavior trees
- Designing the collision detection system
- Adding a new build tool or dependency
- Changing the network protocol format
- Restructuring the ECS component/system organization

## Project Structure

```
hormuz/
  shared/              # Source of truth (YAML definitions, codegen scripts)
    ai/                # Bot AI behaviors (Lua) — embedded by BOTH server (lupa) and playground (fengari)
      config.lua       # All AI tuning constants (single source of truth)
      lib/steering.lua # Steering primitives, target scoring, waypoint following
      behaviors/       # One file per behavior (tanker_transit, escort, swarm_attack, ...)
      main.lua         # Dispatch, danger scent, threat picture, collision avoidance
      contract_fixtures.json  # Cross-host parity fixtures (regenerate: UPDATE_AI_FIXTURES=1)
  server/              # Python backend (FastAPI, ECS, game loop)
    src/hormuz/
      main.py          # FastAPI app, WebSocket, game loop, entity spawning
      components.py    # ECS components (Transform, VehiclePhysics, Health, etc.)
      protocol.py      # MessagePack message encoding/decoding
      map_data.py      # Spawn points, shipping lanes, exits (ported from client)
      systems/         # esper Processors (physics, bot_ai, collision, combat, spawn)
        ai_bridge.py   # lupa host for shared/ai (VM ownership, hot reload, gamedata injection)
        bot_ai.py      # Thin esper adapter: world view -> ai_bridge -> BotControl
      generated/       # Auto-generated from YAML (vehicles, factions, heightmap)
    tests/             # pytest tests for server systems
  client/              # TypeScript frontend (Three.js renderer, networking)
    src/
      render/          # Rendering (camera, colors, shaders, scene, vehicle models + renderers)
        shaders/       # GLSL shaders (vertex + fragment)
        ciws-controller.ts  # Client-side CIWS turret targeting + tracer particles
      vehicles/        # Physics engine + collision (reference implementation)
      ai/              # Lua AI host (lua-host.ts, fengari VM) + game-data builder + behavior tests
      effects/         # Visual effects system (wake trails, explosions, sinking)
      map/             # Geographic data, terrain, heightmap, coastlines
      net/             # WebSocket connection + MessagePack protocol
      game/            # Entity state store + snapshot interpolation
      input/           # Input system (keyboard, touch, unified input manager)
      generated/       # Auto-generated from YAML
  playground/          # Dev sandbox (renderer, spawner, Lua AI with live config tuning)
```

**Data flow:** `shared/*.yaml` -> `shared/scripts/generate.py` -> `server/src/hormuz/generated/` + `client/src/generated/`

**Coastline data:** `shared/scripts/generate_coastlines.py` -> `client/src/map/coastlines.ts` (auto-generated from Natural Earth 10m data, do not edit by hand)

**Heightmap data:** `shared/scripts/generate_heightmap.py` -> `client/src/map/heightmap-data.ts` + `server/src/hormuz/generated/heightmap.py` (auto-generated from NOAA ETOPO1 elevation data, do not edit by hand)

**Key rule:** Generated files are never edited manually. Change the source YAML or the generator script, then run `pnpm generate`, `pnpm generate:coastlines`, or `pnpm generate:heightmap`.

## Code Style

- **TypeScript:** Strict mode. Biome for linting and formatting. Target ES2022.
- **Python:** 3.12+. Ruff for linting and formatting. Line length 100.
- **Both:** Prefer explicit over clever. No abbreviations in public APIs. Short functions that do one thing.

Do not add comments explaining *what* code does — the code should be readable enough on its own. Add comments only for *why* — decisions that aren't self-evident from the code.

## Testing Philosophy

Tests have a cost. They are a maintenance burden, they consume context during refactors, and they slow down the feedback loop when they fail for the wrong reasons. This cost is worth paying — but only when each test earns its place.

Every test must satisfy all three criteria:

1. **Reduces the chance of bugs being introduced.** If this test disappeared, would a real bug be more likely to ship? If not, delete the test.
2. **Makes refactoring easier, not harder.** Tests should break when behavior changes, not when implementation changes. A refactor that preserves behavior should never require updating tests. If it does, the test is coupled to implementation details and should be rewritten or removed.
3. **Provides useful information when it fails.** A failing test should tell you *what went wrong* and *where*, not just that something is broken. "Expected 42, got 43" is useful. A 500-line snapshot diff is not.

### What to test

**Test at boundaries and contracts:**

- Serialization round-trips (MessagePack encode/decode produces identical data)
- Network protocol compatibility (both Python and TypeScript agree on message format)
- Public API behavior (given this input, expect this output)
- Game logic invariants (physics conserves expected properties, ECS processors produce correct state transitions)
- Coordinate math (geo conversions, isometric projections, inverse transforms)

**Test behavior, not implementation:**

- Test what a function *does*, not *how* it does it internally
- The "unit" in unit test is a unit of **behavior**, not a unit of code — a single test may exercise multiple functions if they form a cohesive behavior
- Mocking is appropriate at architectural boundaries (network, file system, external services) — never between internal modules
- If you need to reach into private state to write a test, that's a signal the test is at the wrong level of abstraction

**Use property-based testing for math and serialization:**

- Coordinate transforms: `inverse(transform(point)) === point`
- Serialization: `deserialize(serialize(message)) === message`
- Physics invariants: vehicle position stays within bounds for all valid inputs
- Property-based tests find edge cases humans miss (NaN, negative zero, empty arrays, boundary values) and automatically shrink failures to minimal reproductions

### What not to test

- **Rendering output.** Visual correctness is verified manually in the playground. Do not attempt to test Three.js draw calls.
- **What the type system already guarantees.** If TypeScript's strict mode ensures a value can't be null, don't write a test for it.
- **Trivial getters, setters, or pass-through functions.** These have near-zero bug probability.
- **Implementation details.** Don't test which internal helper was called, what order operations happen in, or what intermediate data structures look like.
- **Anything for coverage metrics.** No test should exist solely to increase a coverage number.

### Test structure

Follow the Arrange-Act-Assert pattern. One behavior per test. Name tests by the behavior they verify, not the function they call:

```
// Good: describes the behavior
"tanker at full speed takes 3 ticks to stop"
"inbound lane coordinates stay south of Iran coast"

// Bad: describes the implementation
"test updateVehicle"
"test geo function"
```

### Testing frameworks

**TypeScript:** Vitest (shares Vite's config and transform pipeline). Property-based testing with `@fast-check/vitest`.

**Python:** pytest with pytest-asyncio (`asyncio_mode = "auto"`).

### When to add tests

- When building a new system (physics, collision, AI, networking) — write tests for the public behavioral contracts
- When fixing a bug — write a test that would have caught it
- When a refactor touches core logic — verify existing tests still pass; add tests if a behavior was previously untested
- Before merging code that touches serialization or protocol messages — these are the highest-risk boundaries

### When to delete tests

- When a test breaks during a pure refactor (behavior unchanged) — the test was testing implementation, not behavior. Rewrite it at the right level or remove it.
- When a test hasn't caught a bug in a long time and tests something trivial — it's not earning its maintenance cost.
- When the code it tests no longer exists.

## Development Workflow

**Running services:**

- `pnpm dev:playground` — dev sandbox with hot reload
- `pnpm dev:client` — game client dev server (port 3000)
- `pnpm dev:server` — Python backend with auto-reload (port 8000)

**Code generation:**

- `pnpm generate` — regenerate Python + TypeScript from YAML definitions
- `pnpm generate:coastlines` — regenerate coastline data from Natural Earth
- `pnpm generate:heightmap` — regenerate terrain heightmap from NOAA ETOPO1 data

**Testing:**

- `pnpm test` — run all client tests (Vitest)
- `pnpm --filter client test:watch` — watch mode
- `cd server && uv run --extra dev pytest tests/ -v` — run server tests (pytest)

**Linting:**

- `pnpm lint:client` / `pnpm lint:playground` — Biome
- `pnpm lint:server` — Ruff

## Architecture Decisions

Decisions that have already been made (do not revisit without explicit request):

- **Renderer:** Three.js (migrated from PixiJS v8 — see `DECISIONS.md`). Single Three.js canvas with DOM overlay HUD. `logarithmicDepthBuffer` enabled for correct depth across custom ShaderMaterial shaders (all custom shaders must include `#include <common>` + `#include <logdepthbuf_pars_vertex>` / `#include <logdepthbuf_vertex>` in vertex shaders, and `#include <logdepthbuf_pars_fragment>` / `#include <logdepthbuf_fragment>` in fragment shaders).
- **Server language:** Python 3.12+ with FastAPI + asyncio
- **ECS:** esper (pure Python, zero dependencies)
- **Serialization:** MessagePack over WebSocket (not JSON, not Protobuf)
- **Persistence:** In-memory + SQLite (not PostgreSQL, not Redis)
- **Type sharing:** YAML + codegen (not Protobuf, not shared runtime)
- **Camera:** Isometric projection with zoom/pan. Playground also supports first-person and third-person PerspectiveCamera modes (V key to cycle). The OrthographicCamera remains the default for the game client.
- **Vehicle physics:** Force-based propulsion (engine power vs quadratic drag, emergent top speed). Ships use propeller torque steering (thrust at stern deflected by rudder → torque → angular velocity). Non-ship vehicles (trucks, drones) use direct turnRate steering. Progressive flooding system (hull breaches → water ingress → listing → sinking).
- **Hosting:** Self-hosted via Cloudflare Tunnel, fallback VPS + Docker
- **Coastlines:** Generated from Natural Earth 10m data (not hand-traced)
- **Terrain elevation:** Grid heightmap from NOAA ETOPO1 data, gameplay-scaled (non-linear compression + smoothing). Hillshade rendered as GPU-interpolated texture sprite. Vehicles gain height offset + pitch on slopes. Physics applies gradient force (uphill deceleration, downhill acceleration).
- **Terrain classification (land/water):** Ray-casting point-in-polygon against coastline polygons (`client/src/map/terrain.ts`), not the heightmap grid. The heightmap is too coarse (500-unit cells) for terrain type detection — coastline polygons are the visual ground truth.
- **Collision:** Ships bounce off land, trucks bounce off water (using polygon terrain classifier). Airborne vehicles ignore terrain. Vehicle-vehicle collisions use SAT (Separating Axis Theorem) on convex polygons with impulse-based rigid body resolution (restitution, friction, angular velocity). Each vehicle type has a collision polygon defined in `shared/vehicles.yaml` and generated into `COLLISION_POLYGONS` in both `generated/vehicles.ts` and `generated/vehicles.py`. Contact points are computed geometrically by SAT, producing natural torque on off-center hits.
- **Server-authoritative simulation:** Server runs all physics at 20Hz. Clients send input and render interpolated state. Client physics code (`vehicles/physics.ts`) is the reference implementation; server physics (`systems/physics.py`) is the authoritative port. Client-side prediction may be added later as a layer on top — the server code won't change.
- **ECS processor order:** BotAI (priority 6) → Physics (5) → Grounding (4) → Combat (3) → Collision (2) → Spawn (1). Network broadcast happens after `esper.process()` in the async game loop. Higher priority = runs first.
- **Bot AI architecture:** Colony-insect-inspired emergent behavior. Two "scents": tanker presence (sensed directly by frigates) and danger scent (emitted at attack sites, decays over 60s). Tankers follow lane waypoints + brake for tankers ahead + drift from danger. Frigates attract to tanker presence + rush to danger + repel other frigates. Complex convoy formations emerge from these local rules without central coordination. See `shared/ai/README.md` for full behavior details. **The AI is written once in Lua (`shared/ai/`) and embedded in both hosts**: the server via lupa (`systems/ai_bridge.py`), the playground via fengari (`client/src/ai/lua-host.ts`). Hosts inject `ai.gamedata` (lanes, zones, detection ranges from generated YAML data) and `is_land`; bot state (target, waypoint, stamina) persists in the hosts, so the server can hot-reload scripts without losing it. Danger scents live in the VM. Cross-host parity is pinned by `shared/ai/contract_fixtures.json` (7 scenarios, tick-by-tick outputs compared in both Vitest and pytest).
- **Snapshot protocol:** Full snapshots sent at 20Hz to all clients (msgpack arrays). Delta snapshots deferred until entity count requires it. Each entity includes `angular_velocity` (field index 9), `flood_level` (index 10), `list_angle` (index 11), and `battery_pct` (index 12).
- **Visual effects:** Client-side procedural effect system. `ThreeEffectManager` (`effects/manager.ts`) owns a `THREE.Group` and handles continuous effects (wake trails, stern churn) tied to entity state and transient effects (explosions, sinking) spawned from game events or HP changes. Each effect implements `ThreeEffect` (owns Three.js objects, update receives zoom for screen-pixel sizing). Wake trails use ribbon mesh geometry; particles use `THREE.Points` with custom ShaderMaterial.
- **Angular velocity:** `Transform` has an `angular_velocity` field (server + client). Collision impulses and propeller torque both set it; `PhysicsProcessor` applies it to heading each tick and dampens via `angular_drag` (per-vehicle parameter on `VehiclePhysics`). This allows ships to spin realistically after off-center impacts and turn via rudder-deflected thrust.
- **Flooding:** `Transform` has `flood_level`, `list_angle`, `hull_breaches`, `breach_side` fields. `PhysicsProcessor` runs `_update_flooding` each tick — water ingress accelerates with flood level, list angle lerps toward damaged side, additional drag slows the ship. Flood level caps based on `hull_breaches / BREACHES_TO_SINK` (from YAML) — multiple breaches are needed to fully sink. When `flood_level >= 1.0`, the entity dies. Combat creates hull breaches on tankers (instead of instant kills); shaheds still die instantly on impact. `BREACHES_TO_SINK` is defined in `shared/vehicles.yaml` and generated; visual-only flooding constants (`breachRate`, `maxList`, `lerpRate`, etc.) remain in `physics.ts` (client) and `physics.py` (server).
- **Battery:** Airborne drones have a `Battery` component (finite energy supply). `charge` drains over time via `drain_rate`; when depleted the drone dies. `battery_pct` is broadcast in snapshots for client HUD display.

## Conventions

- **Generated code is gitignored.** The YAML source and generator scripts are committed; output is not.
- **The playground is the primary development tool.** Build and test features there before integrating into the game client.
- **Vehicle definitions live in YAML.** All vehicle data (physics, collision, HP, radar, combat) lives in `shared/vehicles.yaml`. Adding a vehicle means editing the YAML and running `pnpm generate` — not writing TypeScript or Python by hand.
- **Coordinate system:** Origin (0,0) = top-left (northwest). X = east, Y = south. Geo conversion: `game_x = (lon - 47.5) * 9708`, `game_y = (30.5 - lat) * 10800`.
- **Map renderer uses Three.js.** `ThreeMapRenderer` (`render/map-renderer.ts`) creates all map geometry once in world coordinates — the isometric camera handles projection, so no per-frame geometry updates are needed. Layers: water (ShaderMaterial), land fills (ShapeGeometry from coastline polygons), terrain (heightmap ShaderMaterial, stencil-masked to coastlines), overlays (lines + markers).
- **Vehicle models are shared.** `render/vehicle-models.ts` contains pure geometry data (block outlines, heights, details) used by the Three.js renderer (`render/vehicle-meshes.ts`). Adding a visual vehicle model means editing `vehicle-models.ts`.
- **Vehicle renderer uses Three.js.** `ThreeVehicleRenderer` (`render/vehicle-renderer.ts`) maintains an object pool of `THREE.Group` meshes keyed by entity ID. Blocks are `ExtrudeGeometry` with a `ShaderMaterial` that shades faces based on world-space normals (top=faction color, south-dominant sides=darken 0.45, east-dominant=darken 0.65). The depth buffer handles isometric sorting — no manual sort needed.
- **Single canvas + DOM HUD.** `index.html` has a `#game-container` div with one Three.js canvas (map, vehicles, effects) and a DOM overlay for HUD text.
- **Three.js coordinate system.** X = east (game X), Y = up (height), Z = south (game Y). A game point `(gx, gy)` at height `h` becomes `new THREE.Vector3(gx, h, gy)`. The OrthographicCamera looks along `(1,1,1)` with up `(-1,2,-1)`, producing pixel-identical isometric projection to the 2D `worldToScreen()`. See `render/camera-sync.ts` for the math.
- **Heightmap vs coastlines:** The heightmap (`heightmap.ts`) is for elevation, slopes, hillshade, and physics forces. The coastline polygons (`terrain.ts`) are for land/water classification. Do not use the heightmap to determine whether a point is on land or water — the 500-unit grid resolution does not match the visual coastline.
- **esper `try_remove_component` is broken.** It raises `KeyError` when the entity doesn't have the component but another entity does. Always guard with `has_component` before `remove_component`. Never use `try_remove_component`.
- **Server ECS tests must use isolated worlds.** esper processors persist across tests. Use `esper.switch_world()` / `esper.delete_world()` in a pytest fixture (see `tests/conftest.py`) to give each test a clean world.
- **Vehicle data is generated from YAML — never hardcode.** All vehicle physics params, collision polygons, HP, radar detection ranges, autocannon params, jam radius, and quadcopter damage are defined in `shared/vehicles.yaml` and generated into both `client/src/generated/vehicles.ts` and `server/src/hormuz/generated/vehicles.py` by `pnpm generate`. To change any of these values, edit the YAML and run codegen — never edit the generated files or hardcode values in consumer code. The codegen computes `drag_coefficient` (= `engine_power / max_speed²`) and `rudder_flow_coefficient` (= `rudder_flow_factor * engine_power / max_speed²`).
- **Adding a new vehicle type:** Add it to `shared/vehicles.yaml` with all sections (`physics`, `collision_polygon`, `health`), run `pnpm generate`, then add its visual model in `vehicle-models.ts` and AI behavior in `shared/ai/behaviors/` (registered in `shared/ai/main.lua`). No need to touch physics.ts, collision.ts, or combat.py.
- **Editing AI behaviors:** Edit `shared/ai/*.lua` — both hosts pick it up (server hot-reloads within ~3s; playground reloads via Vite). Tuning constants live ONLY in `shared/ai/config.lua` (never hardcode in behaviors). After intentional behavior changes, regenerate parity fixtures with `UPDATE_AI_FIXTURES=1 pnpm --filter @hormuz/client test -- contract` and confirm `cd server && uv run --extra dev pytest tests/` still passes.
- **Collision polygons** are in local space `[forward, starboard]` as fractions of vehicle `size`, CCW winding order, 4-8 vertices. Defined per-vehicle in `shared/vehicles.yaml` under `components.collision_polygon`.
- **Collidable component stores polygon vertices.** `Collidable` takes a tuple of `(x, y)` vertex pairs (not a radius). It auto-computes `bounding_radius` for broad-phase checks. The combat system uses `bounding_radius * size` for shahed-tanker hit detection.
