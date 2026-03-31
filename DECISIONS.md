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
