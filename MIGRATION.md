# Three.js Migration Plan

## Overview

Migrate the Hormuz renderer from PixiJS to Three.js to gain:
- Real depth buffer (solves vehicle sorting artifacts)
- True 3D meshes (enables altitude layers, helicopters over frigates, dive attacks)
- Camera flexibility (isometric, first-person, free-look per vehicle type)
- Proper occlusion without painter's algorithm hacks

## What doesn't change

These files are rendering-agnostic and need zero modifications:
- Game logic: `entities.ts`, `interpolation.ts`, `physics.ts`, `collision.ts`
- Networking: `connection.ts`, `protocol.ts`
- Input: `keyboard.ts`
- Map data: `data.ts`, `heightmap.ts`, `coastlines.ts`, `terrain.ts`
- Camera math: `camera.ts` (pure math, no PixiJS imports)
- Colors: `colors.ts`
- All server code
- All tests for the above

Only 10 files import from PixiJS: `render/vehicle-renderer.ts`, `render/map-renderer.ts`, `effects/*.ts`, `effects/manager.ts`, `client/src/main.ts`, `playground/src/main.ts`.

## Phases

### Phase 0: Foundation (Three.js scene + camera)

**Status: DONE**

**Goal:** Three.js renderer exists alongside PixiJS. Nothing visual changes. Isometric camera is proven correct via tests.

**New files:**
- `client/src/render/three/scene.ts` — WebGLRenderer, Scene, OrthographicCamera setup
- `client/src/render/three/camera-sync.ts` — Syncs existing Camera interface → Three.js OrthographicCamera
- `client/src/render/three/camera-sync.test.ts` — Verifies Three.js projection matches worldToScreen() output

**Modify:**
- `client/package.json` — add `three` + `@types/three`

**Isometric camera setup:**
- OrthographicCamera looking along (-1, -1, -1) normalized, Z-up
- World X = east, Y = south, Z = height
- Ortho frustum: screenWidth / (2 * zoom), screenHeight / (2 * zoom)
- Existing projection: screen_x = (wx - wy) * cos30, screen_y = (wx + wy) * sin30

**Gate:** Camera-sync test must pass before proceeding. This is the #1 risk.

### Phase 1: Map rendering

**Status: DONE**

**Goal:** Water, terrain, coastlines, overlays render via Three.js. Transitional dual-canvas: Three.js for map, PixiJS (transparent) for vehicles/effects/HUD on top.

**New files:**
- `client/src/render/three/map-renderer.ts` — Water + terrain PlaneGeometry with ShaderMaterial, coastline ShapeGeometry, overlay lines/markers
- `client/src/render/shaders/water-three.frag` — Adapted from water.frag (remove PixiJS vColor multiply)
- `client/src/render/shaders/terrain-three.frag` — Adapted from terrain.frag
- `client/src/render/shaders/map-three.vert` — Three.js MVP vertex shader

**Shader porting notes:**
- Fragment shaders are ~95% portable (pure GLSL math)
- Remove `in vec4 vColor` and `* vColor` multiplication
- Use Three.js ShaderMaterial with `glslVersion: THREE.GLSL3`
- Vertex shader replaces PixiJS-specific uniforms (uProjectionMatrix etc.) with Three.js builtins (modelViewMatrix, projectionMatrix)

**Modify:** `client/src/main.ts`, `client/index.html` — dual-canvas setup

### Phase 2: Vehicle rendering (parallelize with Phase 3)

**Status: DONE**

**Goal:** Vehicles are real 3D meshes with depth buffer sorting. Sorting problem solved permanently.

**New files:**
- `client/src/render/three/vehicle-meshes.ts` — Converts VehicleModel block definitions → ExtrudeGeometry groups
- `client/src/render/three/vehicle-renderer.ts` — Object pool of Three.js Groups keyed by entity ID

**Key details:**
- Each Block → ExtrudeGeometry from Shape, depth = topHeight - baseHeight
- Top face: factionColor, south sides: darken(0.45), east sides: darken(0.65)
- FlatDetail lines → THREE.Line or thin mesh, circles → CircleGeometry
- Object pool pattern: reuse mesh groups across frames, only update position/rotation
- Remove manual sort((a, b) => a.x + a.y - ...) — depth buffer handles it
- position.set(x, y, elevation), rotation.z = heading, pitch from slope

**Reused as-is:** All 6 model definitions (pure geometry data), darken(), getElevation(), getSlopeAlongHeading()

### Phase 3: Effects system (parallelize with Phase 2)

**Status: DONE**

**Goal:** All 4 effect types become Three.js objects.

**New files:**
- `client/src/effects/three/types.ts` — ThreeEffect interface (owns Three.js objects, update receives zoom)
- `client/src/effects/three/wake-trail.ts` — Ribbon mesh BufferGeometry with per-vertex alpha
- `client/src/effects/three/stern-churn.ts` — THREE.Points particle system with circular point shader
- `client/src/effects/three/explosion.ts` — Billboarded shader plane (core/ring/smoke) + debris Points
- `client/src/effects/three/sinking.ts` — ShapeGeometry hull mesh + bubble Points
- `client/src/effects/three/manager.ts` — Same lifecycle logic, Three.js scene graph

**Reused:** ~60% of each effect file (simulation logic: aging, velocity, emission rates, spread, durations)

**Resolved risk:** Wake trails use a ribbon mesh (triangle-strip geometry rebuilt each frame) with zoom-dependent widths to maintain screen-pixel visual parity

### Phase 4: HUD to DOM overlay

**Status: DONE**

**Goal:** HUD text from PixiJS Text → plain HTML/CSS. Removes last PixiJS usage from main.ts.

**New files:**
- `client/src/render/hud.ts` — DOM element management for vehicle label, war cost, status

**Modify:** `client/index.html`, `client/src/main.ts` — remove PixiJS Application, use requestAnimationFrame

### Phase 5: Playground migration

**Status: DONE**

**Modify:** `playground/src/main.ts` — Replace PixiJS with Three.js, import new renderers. lil-gui unaffected.

### Phase 6: Cleanup

**Status: DONE**

- Deleted old PixiJS files (map-renderer.ts, vehicle-renderer.ts, effects/*.ts, old shaders)
- Moved effects/three/* → effects/ and render/three/* → render/
- Renamed shaders (removed -three suffix)
- Inlined MapLayers/DEFAULT_LAYERS into the Three.js map-renderer
- Removed pixi.js from package.json
- Updated all imports in client and playground
- Full test suite passes (146 tests)

## Parallelism

```
Phase 0 → Phase 1 ──┬── Phase 2 (vehicles) ──┬── Phase 5 → Phase 6
                     │                         │
Phase 4 (HUD) ──────┘── Phase 3 (effects) ────┘
```

## Risk ranking

1. Camera projection alignment (Phase 0) — HIGHEST — if wrong, everything breaks
2. Wake trail fidelity (Phase 3) — HIGH — WebGL line width limitations
3. Shader porting (Phase 1) — MEDIUM — subtle visual differences possible
4. Vehicle mesh pooling (Phase 2) — MEDIUM — must not create/destroy per frame
5. Dual-canvas performance (Phase 1 transitional) — LOW — temporary
