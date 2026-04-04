# Bot AI — Emergent Behavior from Simple Rules

Inspired by colony insects: tankers are worker ants following a trail, frigates are
soldier ants that position themselves around the workers. No entity has a global plan.
Complex convoy formations emerge from local interactions between simple agents.

## The Two-Chemical Model

The system uses two "scents" — indirect signals that agents sense and respond to:

1. **Presence scent:** Every tanker implicitly emits it (frigates sense nearby tankers
   directly). Frigates are attracted; this pulls them toward the convoy.

2. **Danger scent:** Emitted at the location of hull breaches and kamikaze impacts.
   Decays linearly over 60 seconds. Frigates are strongly attracted (rush to defend);
   tankers are weakly repelled (drift away from danger).

## Behaviors

### Tanker: `tanker_transit`

Three rules:

1. **Follow the lane.** Waypoint-following along `LANE_OUTBOUND` or `LANE_INBOUND`
   at full throttle.
2. **Brake for tankers ahead.** If another tanker is within 400u ahead (dot product
   with heading > 0), reduce throttle proportionally. Closer = slower. Minimum
   throttle: 40%.
3. **Drift away from danger.** If a danger scent is within 3000u, bias the rudder
   away from it. Strength scales with scent freshness.

**Emergent effect:** Tankers naturally form a spaced column along the shipping lane.
The lead tanker runs at full throttle; followers brake as they approach, settling into
a stable spacing. When a tanker is attacked, nearby tankers subtly drift away from
the impact site.

### Frigate: `escort`

Three rules:

1. **Escort the least-contested tanker.** Pick a tanker using pressure scoring
   (`1 / (distance² × (1 + frigates_already_escorting_it))`). Steer toward it;
   if closer than 800u (offset distance), match the tanker's heading direction.
   Uses lane waypoints for long-distance navigation to avoid islands.
2. **Rush toward danger.** Steer toward the nearest danger scent within 8000u.
   Strength scales with scent freshness. Full throttle when danger is active.
3. **Repel from other frigates.** Steer away from any frigate within 2000u. Closer
   frigates push harder.

If no tankers or danger exist, the frigate patrols toward the strait center.

**Emergent effect:** With 8 frigates and 20 tankers, pressure scoring distributes
frigates roughly 1 per 2–3 tankers across the entire shipping lane — no clustering
around Qeshm or any single group. Each frigate follows its assigned tanker for the
full transit. When a tanker is sunk, its frigate automatically redistributes to
the next least-protected tanker. When an attack happens, danger scent temporarily
pulls nearby frigates toward the threat. As the scent fades (60s), they return to
their assigned tankers.

Frigates and drones use separate pressure pools, so a frigate escorting a tanker
doesn't affect which tanker a shahed targets (and vice versa).

### Iranian Drones

Both drone types use the same two-rule swarm system:

1. **Target pressure avoidance** — score each potential target by
   `1 / (distance² × (1 + drones_already_targeting_it))`. Pick the highest-scoring
   target. The current target gets a stickiness bonus (`TARGET_STICKINESS = 0.5`) to
   prevent oscillation, but if pressure is high enough the drone switches. Counts are
   updated live during the dispatch loop so each successive drone sees accurate pressure.

2. **Drone-drone repulsion** — steer away from nearby same-type drones (shaheds: 1000u,
   quadcopters: 500u). This diversifies approach angles on the same target.

**Emergent effect:** Drones naturally distribute across multiple targets (no piling on
one ship) and approach each target from different angles (no single firing arc for CIWS
to cover). Two drones on the same target fan out into a pincer. Eight drones across
four tankers distribute 2-per-target. If one target is destroyed, its drones
immediately redistribute to others.

#### `shahed_intercept`
Targets: civilian tankers only. Unlimited detection range (they can see any tanker).
If jammed by a nearby frigate's RF (within `JAM_RADIUS`), lose steering — fly straight
until out of jam range or dead. Repulsion range: 1000u.

#### `quadcopter_intercept`
Targets: civilian tankers and US frigates. Detection range: 8000u (FPV camera).
Autonomous (immune to RF jamming). If no target visible, head toward strait center.
Limited by battery. Repulsion range: 500u (tighter formation, but diverges on approach).

## Danger Scent System

The danger scent is a shared spatial data structure (`systems/danger_scent.py`):

- **Emission:** Combat processor calls `emit_danger_scent(x, y)` when a shahed or
  quadcopter hits a target (any kamikaze impact, regardless of whether it causes
  hull breaches).
- **Storage:** Simple list of `(x, y, timestamp)` tuples.
- **Decay:** Linear from strength 1.0 at emission to 0.0 after 60 seconds.
- **Pruning:** Expired entries removed once per tick by `BotAIProcessor.process()`.
- **Sensing:** `nearest_danger(x, y, max_range_sq)` returns the direction and strength
  of the nearest active scent, or `None`.

## Shared Systems (Applied After All Behaviors)

### Exclusion Zones
Rectangular keep-out areas. If a bot enters one, it steers toward the nearest shipping
lane waypoint. Applied before land avoidance.

### Land Avoidance
Seven probes at 0/±20/±40/±60 degrees from heading. When land is detected, the
behavior's rudder is overridden — hard turn away. Forward land also cuts throttle to
30%. **Highest priority** — applied last.

### Friendly Vessel Avoidance
Ships steer away from nearby same-faction vessels ahead of them. Cross-product
determines which side; strength scales with proximity. Applied as a rudder adjustment
(additive), not an override.

### Grounding
Ships on land are pushed toward the nearest water, slowed, and accumulate hull breaches
after a grace period.

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `TANKER_BRAKE_RANGE` | 400u | Brake for tankers ahead within this distance |
| `TANKER_BRAKE_MIN_THROTTLE` | 0.4 | Minimum throttle when braking |
| `TANKER_DANGER_RANGE` | 3000u | Tanker danger sensing radius |
| `TANKER_DANGER_RUDDER` | 0.3 | Max rudder bias from danger |

| `FRIGATE_OFFSET_DIST` | 800u | Desired distance from assigned tanker |
| `FRIGATE_DANGER_RANGE` | 8000u | Frigate danger sensing radius |
| `FRIGATE_REPEL_RANGE` | 2000u | Frigate-frigate repulsion radius |
| `WEIGHT_PRESENCE` | 0.6 | Steering weight for tanker attraction |
| `WEIGHT_DANGER` | 1.0 | Steering weight for danger attraction |
| `WEIGHT_REPEL` | 0.5 | Steering weight for frigate repulsion |
| `FRIGATE_CRUISE_THROTTLE` | 0.6 | Throttle when near tankers |
| `DANGER_SCENT_DURATION` | 60s | Time until danger scent expires |
| `DRONE_REPEL_RANGE_SHAHED` | 1000u | Shahed-shahed repulsion radius |
| `DRONE_REPEL_RANGE_QUAD` | 500u | Quadcopter-quadcopter repulsion radius |
| `DRONE_REPEL_WEIGHT` | 0.4 | Steering weight for drone repulsion |
| `TARGET_STICKINESS` | 0.5 | Score bonus for keeping current target |
