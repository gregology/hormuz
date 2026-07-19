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

1. **Escort the least-covered tanker.** Pick a tanker using pressure scoring
   (`1 / (distance × (1 + pressure)³)`). Pressure is the *greater* of direct
   escort count and **geographic coverage** — a distance-weighted count of
   frigates within 6,000u of the tanker (`ESCORT_COVERAGE_RADIUS`). This
   prevents clustering: a tanker near 5 frigates (even if they're escorting
   different ships) appears well-covered, pushing new frigates toward the
   unprotected ends of the route. Linear distance (not squared) and cubic
   pressure ensure that uncovered tankers far away outscore covered nearby
   ones. Steer toward it; if closer than 800u (offset distance), match the
   tanker's heading direction. Uses lane waypoints for long-distance
   navigation to avoid islands.
2. **Rush toward danger.** Steer toward the nearest danger scent within 8000u.
   Strength scales with scent freshness. Full throttle when danger is active.
3. **Repel from other frigates.** Steer away from any frigate within 2000u. Closer
   frigates push harder.

If no tankers or danger exist, the frigate patrols toward the least-covered
**patrol anchor** — five evenly-spaced points along the alt lane (west gate,
quarter, midpoint, three-quarter, east gate). This spreads idle frigates
across the full route instead of bunching.

4. **Threat-aware escort scoring.** The coalition threat picture (see below)
   feeds into escort target selection. When scoring tankers, the number of
   coalition-detected enemies within 5,000u of each tanker multiplies its
   score by `(1 + 2 × threat_count)`. A tanker with 2 nearby speedboats
   scores 5× higher than an equally-distant safe tanker.

**Emergent effect:** With 10 frigates and 20 tankers, the cubic pressure term
ensures each tanker gets ~1 escort before any gets 2. The threat boost causes
frigates to proactively redeploy toward endangered tankers — when speedboats
close in on a tanker, nearby frigates sense the threat via coalition radar and
shift their escort priority. Danger scent (25,000u range) provides longer-range
attraction once attacks actually begin. When no tankers are present, frigates
spread across five patrol anchors for geographic coverage.

Frigates and drones use separate pressure pools, so a frigate escorting a tanker
doesn't affect which tanker a shahed targets (and vice versa).

### Speedboat Wolf Pack: `swarm_attack`

Speedboats follow a **foraging wasp** model: they leave their spawn with
full stamina, hunt aggressively, then return home to recharge when depleted.
This creates natural hit-and-run cycles without any explicit state machine.

**Stamina** (0.0–1.0) is the single scalar driving the cycle:
- Drains at 0.015/s while away from spawn (~45s of aggression after transit)
- Drains faster at 0.04/s while in attack range of a tanker
- Recharges at 0.1/s when within 1,500u of a spawn point (~7s to refuel)
- Below 0.3: retreat to nearest spawn. Above 0.3: hunt.

Six rules:

1. **Stamina management.** Recharge near spawn, drain while out. Faster
   drain during active engagement creates shorter, more intense attack runs.

2. **Frigate evasion (highest priority).** If the nearest US frigate is
   within 3,500u, the speedboat flees at full throttle regardless of
   stamina or target. While fleeing, releases its target.

3. **Retreat when depleted.** When stamina ≤ 0.3 and not near a spawn,
   head to the nearest spawn point at full speed. Releases target.

4. **Target pressure avoidance with frigate penalty.** While hunting
   (stamina > 0.3): same scoring as drones but targets with a frigate
   within 4,000u get their score multiplied by 0.05 (20× penalty).
   Visual range: 8,000u. Targets civilian tankers only.

5. **Approach → attack run.** Beyond 300u, head straight for the target at
   full throttle. Within 300u, steer to run alongside the tanker (aiming at a
   point ahead of it along its heading) to maintain bow gun arc. Throttle
   reduces near the tanker to avoid overshooting.

6. **Danger attraction + pack repulsion.** Attracted to danger scent within
   6,000u. Repel from other speedboats within 300u.

**Emergent effect:** Speedboats cycle in waves — 2–3 attack a tanker for
15–20s, break off as stamina depletes, retreat to the Iranian coast, and
return recharged. Because different speedboats start at different times and
travel different distances, their cycles naturally stagger: one returns home
while another heads out, creating near-continuous harassment with brief
windows of relief. Speedboats from the same spawn point form a natural
relay. When frigates are present, speedboats burn stamina evading instead
of attacking, shortening their raids. If all tankers are escorted, they
lurk near spawn waiting for an opening.

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

## Radar Detection Model

Detection range between any two vehicles is computed from two YAML properties:

- **`radar_cross_section`** (on every vehicle): physical radar reflectivity in m².
  Larger = easier to detect. Oil tanker: 50,000. Quadcopter: 0.01.
- **`radar.sensitivity`** (on radar-equipped vehicles only): quality of the radar
  system. Higher = can resolve smaller cross sections at greater range.
  Frigate: 2,378. Tanker: 89. Drones/speedboats: no radar.
- **`radar.max_range`** (on radar-equipped vehicles): hard ceiling from earth
  curvature / radar horizon. Frigate: 20,000u. Tanker: 3,000u.

**Formula** (computed at codegen time):
```
detection_range(observer, target) = min(max_range, sensitivity × rcs^0.25)
```

The `rcs^0.25` exponent comes from the real radar range equation. Codegen produces
a `DETECTION_RANGE[observer_type][target_type]` lookup table.

Key ranges (frigate → target): shahed ~2,000u, speedboat ~4,000u, quadcopter ~750u,
oil tanker ~20,000u (clamped). Tanker → speedboat: ~150u (barely detects).

Speedboats and drones have no radar — they detect targets visually using flat
`VISUAL_RANGE` constants (speedboat: 8,000u, shahed: 5,000u, quadcopter: 8,000u).

## Coalition Threat Picture

The coalition threat picture (`systems/threat_picture.py`) pools radar detections
across allied vessels each tick:

1. **Build phase:** Every radar-equipped vessel (frigates, tankers) scans all
   enemy vessels. If an enemy is within `DETECTION_RANGE[observer][target]`,
   it's added to the US coalition threat list.
2. **Coalition sharing:** Civilian (tanker) detections are shared with US forces.
   If a tanker's basic nav radar picks up a speedboat at 100u, every frigate
   in the game knows about it — like a captain radioing for help.
3. **Deduplication:** Each enemy appears at most once in the threat picture,
   regardless of how many vessels detect it.
4. **Consumption:** Frigate escort AI queries `get_threats_near(x, y, radius_sq)`
   to count enemies near each candidate tanker. Tankers with more nearby
   threats get a score multiplier in escort target selection.

This enables a future AWACS aircraft (high sensitivity, huge max_range) to
extend the coalition's detection bubble by simply adding a YAML entry.

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
| `FRIGATE_DANGER_RANGE` | 25000u | Frigate danger sensing radius |
| `FRIGATE_REPEL_RANGE` | 2000u | Frigate-frigate repulsion radius |
| `WEIGHT_PRESENCE` | 0.6 | Steering weight for tanker attraction |
| `WEIGHT_DANGER` | 1.0 | Steering weight for danger attraction |
| `WEIGHT_REPEL` | 0.5 | Steering weight for frigate repulsion |
| `FRIGATE_CRUISE_THROTTLE` | 0.6 | Throttle when near tankers |
| `ESCORT_PRESSURE_POWER` | 3 | Exponent on (1+pressure) for escort scoring |
| `ESCORT_COVERAGE_RADIUS` | 6000u | Frigates within this range count as soft coverage |
| `ESCORT_THREAT_RADIUS` | 5000u | Radius to count threats near tanker |
| `ESCORT_THREAT_WEIGHT` | 2.0 | Score multiplier per nearby threat |
| `PATROL_ANCHORS` | 5 lane points | West/quarter/mid/three-quarter/east patrol positions |
| `DANGER_SCENT_DURATION` | 60s | Time until danger scent expires |
| `SPEEDBOAT_STAMINA_DRAIN` | 0.015/s | Stamina drain while hunting |
| `SPEEDBOAT_STAMINA_DRAIN_ATTACK` | 0.04/s | Stamina drain during attack run |
| `SPEEDBOAT_STAMINA_RECHARGE` | 0.1/s | Stamina recharge rate near spawn |
| `SPEEDBOAT_STAMINA_THRESHOLD` | 0.3 | Retreat when stamina falls below |
| `SPEEDBOAT_HOME_RADIUS` | 1500u | Distance from spawn to recharge |
| `SPEEDBOAT_VISUAL_RANGE` | 8000u | Speedboat target detection range |
| `SPEEDBOAT_ATTACK_RANGE` | 300u | Distance to begin strafing run |
| `SPEEDBOAT_DANGER_RANGE` | 6000u | Danger attraction range |
| `SPEEDBOAT_EVASION_RANGE` | 3500u | Frigate evasion trigger distance |
| `SPEEDBOAT_REPEL_RANGE` | 300u | Pack repulsion radius |
| `SPEEDBOAT_WEIGHT_DANGER` | 0.6 | Danger attraction weight |
| `SPEEDBOAT_EVASION_WEIGHT` | 1.5 | Frigate evasion weight |
| `SPEEDBOAT_FRIGATE_PROXIMITY` | 4000u | Frigate proximity penalty radius for target scoring |
| `DRONE_REPEL_RANGE_SHAHED` | 1000u | Shahed-shahed repulsion radius |
| `DRONE_REPEL_RANGE_QUAD` | 500u | Quadcopter-quadcopter repulsion radius |
| `DRONE_REPEL_WEIGHT` | 0.4 | Steering weight for drone repulsion |
| `TARGET_STICKINESS` | 0.5 | Score bonus for keeping current target |
