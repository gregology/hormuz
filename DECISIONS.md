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

See `MIGRATION.md` for the detailed phase plan, file lists, and risk ranking.

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
