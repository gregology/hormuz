# AGENTS.md

Guidelines for AI agents and human contributors working on Hormuz.

## Project Context

Hormuz is a persistent multiplayer anti-war browser game. Players control military vehicles, civilian oil tankers, and autonomous weapons in the Strait of Hormuz. The game runs 24/7 with ~140 bots and up to 200 concurrent humans. See `README.md` for the full design document and `BRAINSTORM.md` for early decisions.

**Stack:** TypeScript + PixiJS (client), Python 3.12+ + FastAPI + esper ECS (server), WebSocket + MessagePack (networking), YAML + codegen (shared types).

## Core Principle: Optimize for Maintainability and Extensibility

Every decision — architecture, code style, testing, tooling — is evaluated against two questions:

1. **Can this be changed easily later?** Code that resists change is a liability. Prefer designs that are simple to modify, even if they require more upfront thought.
2. **Can a new feature be added without rewriting existing code?** The game will grow to 11+ vehicle types, multiple weapon systems, AI behaviors, and visual effects. Adding a new vehicle should be a data definition + sprite + AI behavior, not a rewrite.

Do not shy away from larger refactors if the result is a more maintainable codebase. A clean refactor now saves compounding complexity later. The test suite exists specifically to make refactors safe and confident.

## When to Act vs When to Propose

### Act autonomously when:
- Fixing a bug with a clear root cause
- Implementing a feature within an established pattern (e.g., adding a new vehicle type using the existing YAML + codegen pipeline)
- Refactoring code to match an existing pattern already used elsewhere in the codebase
- Writing or updating tests
- Fixing lint/format/type errors

### Stop and propose when introducing a new pattern or architecture:
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
  server/              # Python backend (FastAPI, ECS, game loop)
    src/hormuz/
      main.py          # FastAPI app, WebSocket, game loop, entity spawning
      components.py    # ECS components (Transform, VehiclePhysics, Health, etc.)
      protocol.py      # MessagePack message encoding/decoding
      map_data.py      # Spawn points, shipping lanes, exits (ported from client)
      systems/         # esper Processors (physics, bot_ai, collision, combat, spawn)
      generated/       # Auto-generated from YAML (vehicles, factions, heightmap)
    tests/             # pytest tests for server systems
  client/              # TypeScript frontend (PixiJS renderer, networking)
    src/
      render/          # PixiJS rendering (vehicles, map, camera, shaders)
      vehicles/        # Physics engine + collision (reference implementation)
      effects/         # Visual effects system (wake trails, explosions, sinking)
      map/             # Geographic data, terrain, heightmap, coastlines
      net/             # WebSocket connection + MessagePack protocol
      game/            # Entity state store + snapshot interpolation
      input/           # Keyboard input manager
      generated/       # Auto-generated from YAML
  playground/          # Dev sandbox (same renderer, lil-gui controls)
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

- **Rendering output.** Visual correctness is verified manually in the playground. Do not attempt to test PixiJS draw calls.
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

- **Renderer:** PixiJS v8 (not Phaser, not Three.js)
- **Server language:** Python 3.12+ with FastAPI + asyncio
- **ECS:** esper (pure Python, zero dependencies)
- **Serialization:** MessagePack over WebSocket (not JSON, not Protobuf)
- **Persistence:** In-memory + SQLite (not PostgreSQL, not Redis)
- **Type sharing:** YAML + codegen (not Protobuf, not shared runtime)
- **Camera:** Isometric projection with zoom/pan
- **Vehicle physics:** Rudder-based naval simulation (turn rate proportional to speed, lateral drift)
- **Hosting:** Self-hosted via Cloudflare Tunnel, fallback VPS + Docker
- **Coastlines:** Generated from Natural Earth 10m data (not hand-traced)
- **Terrain elevation:** Grid heightmap from NOAA ETOPO1 data, gameplay-scaled (non-linear compression + smoothing). Hillshade rendered as GPU-interpolated texture sprite. Vehicles gain height offset + pitch on slopes. Physics applies gradient force (uphill deceleration, downhill acceleration).
- **Terrain classification (land/water):** Ray-casting point-in-polygon against coastline polygons (`client/src/map/terrain.ts`), not the heightmap grid. The heightmap is too coarse (500-unit cells) for terrain type detection — coastline polygons are the visual ground truth.
- **Collision:** Ships bounce off land, trucks bounce off water (using polygon terrain classifier). Airborne vehicles ignore terrain. Vehicle-vehicle collisions use SAT (Separating Axis Theorem) on convex polygons with impulse-based rigid body resolution (restitution, friction, angular velocity). Each vehicle type has a collision polygon defined in `COLLISION_POLYGONS` in both `collision.ts` and `collision.py`. Contact points are computed geometrically by SAT, producing natural torque on off-center hits.
- **Server-authoritative simulation:** Server runs all physics at 20Hz. Clients send input and render interpolated state. Client physics code (`vehicles/physics.ts`) is the reference implementation; server physics (`systems/physics.py`) is the authoritative port. Client-side prediction may be added later as a layer on top — the server code won't change.
- **ECS processor order:** BotAI (priority 5) → Physics (4) → Collision (3) → Combat (2) → Spawn (1). Network broadcast happens after `esper.process()` in the async game loop. Higher priority = runs first.
- **Snapshot protocol:** Full snapshots sent at 20Hz to all clients (msgpack arrays, ~600 bytes for 20 entities). Delta snapshots deferred until entity count requires it. Each entity includes `angular_velocity` (field index 9).
- **Visual effects:** Client-side procedural effect system (`client/src/effects/`). `EffectManager` owns a PixiJS Container and handles two categories: continuous effects (wake trails, stern churn) tied to entity state, and transient effects (explosions, sinking) spawned from game events or HP changes. All effects drawn with the Graphics API (no sprite assets). Adding a new effect = one new file implementing the `Effect` interface.
- **Angular velocity:** `Transform` has an `angular_velocity` field (server + client). Collision impulses set it; `PhysicsProcessor` applies it to heading each tick and dampens via `angular_drag` (per-vehicle parameter on `VehiclePhysics`). This allows ships to spin realistically after off-center impacts.

## Conventions

- **Generated code is gitignored.** The YAML source and generator scripts are committed; output is not.
- **The playground is the primary development tool.** Build and test features there before integrating into the game client.
- **Vehicle definitions live in YAML.** Adding a vehicle means editing `shared/vehicles.yaml` and running codegen — not writing TypeScript or Python by hand.
- **Coordinate system:** Origin (0,0) = top-left (northwest). X = east, Y = south. Geo conversion: `game_x = (lon - 47.5) * 9708`, `game_y = (30.5 - lat) * 10800`.
- **Map renderer uses a Container** (not a single Graphics). `renderMap()` manages internal children: water Mesh (animated shader), land Graphics (coastline fills), terrain Mesh (elevation shader, masked to coastlines), overlay Graphics (borders, markers). Callers pass a Container.
- **Heightmap vs coastlines:** The heightmap (`heightmap.ts`) is for elevation, slopes, hillshade, and physics forces. The coastline polygons (`terrain.ts`) are for land/water classification. Do not use the heightmap to determine whether a point is on land or water — the 500-unit grid resolution does not match the visual coastline.
- **esper `try_remove_component` is broken.** It raises `KeyError` when the entity doesn't have the component but another entity does. Always guard with `has_component` before `remove_component`. Never use `try_remove_component`.
- **Server ECS tests must use isolated worlds.** esper processors persist across tests. Use `esper.switch_world()` / `esper.delete_world()` in a pytest fixture (see `tests/conftest.py`) to give each test a clean world.
- **Physics params must stay in sync.** The server's vehicle physics dicts (`OIL_TANKER_PHYSICS`, `SHAHED_PHYSICS` in `main.py`) must match the client's factory functions (`createOilTanker`, `createShahed` in `vehicles/physics.ts`). This includes `angular_drag`. When changing physics tuning, update both.
- **Collision polygons must stay in sync.** `COLLISION_POLYGONS` is defined in both `client/src/vehicles/collision.ts` and `server/src/hormuz/systems/collision.py`. The vertex lists must be identical. When adding a new vehicle type, add its collision polygon to both files. Polygons are in local space `[forward, starboard]` as fractions of vehicle `size`, CCW winding order, 4-8 vertices.
- **Collidable component stores polygon vertices.** `Collidable` takes a tuple of `(x, y)` vertex pairs (not a radius). It auto-computes `bounding_radius` for broad-phase checks. The combat system uses `bounding_radius * size` for shahed-tanker hit detection.
