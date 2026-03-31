# Contributing to Hormuz

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (v9+)
- [Python 3.12+](https://www.python.org/)
- [uv](https://docs.astral.sh/uv/) (Python package manager)

## Setup

```bash
pnpm install
cd server && uv sync
```

## Running Services

### Playground (primary dev tool)

```bash
pnpm dev:playground
```

Opens a sandbox at http://localhost:5173 with the same renderer as the final game, lil-gui controls, and hot reload. Build and test features here first.

### Game Client

```bash
pnpm dev:client
```

Vite dev server at http://localhost:3000. Proxies `/ws` and `/api` to the backend.

### Server

```bash
pnpm dev:server
```

FastAPI backend at http://localhost:8000 with auto-reload.

## Code Generation

Source of truth lives in `shared/*.yaml`. Generated files are gitignored — never edit them by hand.

```bash
pnpm generate              # Python + TypeScript from YAML definitions
pnpm generate:coastlines   # Coastline polygons from Natural Earth 10m data
pnpm generate:heightmap    # Terrain elevation from NOAA ETOPO1 data
```

## Testing

### Run all tests

```bash
pnpm test
```

### Watch mode (re-runs on file change)

```bash
pnpm --filter client test:watch
```

### Test stack

| Language   | Framework | Property-based | Config                  |
|------------|-----------|----------------|-------------------------|
| TypeScript | Vitest    | @fast-check/vitest | `client/vite.config.ts` |
| Python     | pytest    | (Hypothesis, planned) | `server/pyproject.toml` |

### What to test

See `CLAUDE.md` for the full testing philosophy. The short version:

- **Test boundaries and contracts:** physics invariants, coordinate round-trips, serialization, terrain classification.
- **Test behavior, not implementation:** the "unit" is a unit of behavior, not a unit of code.
- **Use property-based tests for math:** inverse transforms, serialization round-trips, domain invariants.
- **Don't test rendering.** Visual correctness is verified manually in the playground.

### Current test coverage

| File | What it covers |
|------|---------------|
| `client/src/vehicles/physics.test.ts` | Force-based propulsion, propeller torque steering, flooding, cruise speed, movement |
| `client/src/vehicles/collision.test.ts` | Terrain collisions, vehicle-vehicle collisions, airborne bypass |
| `client/src/render/camera.test.ts` | Isometric projection round-trips, zoom, camera centering |
| `client/src/render/camera-sync.test.ts` | Three.js OrthographicCamera matches 2D isometric projection |
| `client/src/map/heightmap.test.ts` | Elevation queries, gradients, slope projection, hillshade |
| `client/src/map/data.test.ts` | Spawn point terrain/bounds validation, shipping lane integrity |
| `server/tests/test_physics.py` | Server physics: thrust, drag, equilibrium speed, steering, flooding |
| `server/tests/test_combat.py` | Shahed-tanker combat, breach-based damage, explosion events |
| `server/tests/test_collision.py` | Server-side SAT collision, impulse resolution |
| `server/tests/test_bot_ai.py` | Bot steering, waypoint advance |

## Linting

```bash
pnpm lint:client       # Biome (TypeScript)
pnpm lint:playground   # Biome (TypeScript)
pnpm lint:server       # Ruff (Python)
pnpm format:server     # Ruff auto-format (Python)
```

## Project Structure

```
hormuz/
  shared/              # YAML definitions, codegen scripts, Natural Earth cache
  server/              # Python backend (FastAPI, ECS, game loop)
  client/              # TypeScript frontend (Three.js renderer, physics)
  playground/          # Dev sandbox (same renderer, lil-gui controls)
```

## Adding a New Vehicle

1. Add the vehicle definition to `shared/vehicles.yaml`
2. Run `pnpm generate`
3. Add a factory function in `client/src/vehicles/physics.ts` with force-based params (`mass`, `enginePower`, `dragCoefficient`). For ships: set `propellerOffset`, `rudderMaxAngle`, `momentOfInertia`, `rudderFlowCoefficient`. For non-ships: set those to 0.
4. Add a collision polygon in both `client/src/vehicles/collision.ts` and `server/src/hormuz/systems/collision.py`
5. Add a physics dict in `server/src/hormuz/main.py` matching the client factory values
6. Add tests for the new vehicle's physics behavior
7. Build and tune in the playground before integrating into the game client
