# Bot AI — Emergent Behavior from Simple Rules

Each entity in the game follows a single behavior with a handful of rules. No entity has
a global plan. Complex group dynamics — convoys, patrols, area denial — emerge from
local interactions between simple agents, the same way a colony of bees builds a hive
without any individual bee understanding architecture.

## Behaviors

### Tanker Behaviors

#### `tanker_transit`
Follow shipping lane waypoints at full throttle. That's it.
- Outbound tankers follow `LANE_OUTBOUND` (Gulf → Oman)
- Inbound tankers follow `LANE_INBOUND` (Oman → Gulf)
- At the destination, reverse direction and reset waypoints

#### `follow_escort_lead`
Same as `tanker_transit`, but look for an `escort_lead` frigate ahead within 1500u.
If found, steer toward it and throttle down as you get closer:
- \>700u: full throttle (catch up)
- 300–700u: 85% throttle (close gap slowly)
- <300u: 75% throttle (roughly match escort_lead speed)

If no escort_lead is detected, fall back to normal `tanker_transit`.

**Emergent effect:** Tankers naturally cluster 200–500u behind the escort_lead. They
approach at full speed, slow down as they enter detection range, and settle at a
distance where their speed roughly matches the frigate's. No explicit formation code.

### Iranian Drone Behaviors

#### `shahed_intercept`
Fly toward the nearest civilian tanker at full throttle. If jammed by a nearby frigate's
RF (within `JAM_RADIUS`), lose steering — fly straight until out of jam range or dead.
Shaheds have no radar; they use visual detection only (5000u range).

#### `quadcopter_intercept`
Like shaheds but autonomous (immune to RF jamming). Target both civilian tankers and
US frigates. Better optics (8000u detection range). If no target visible, head toward
the strait center. Limited by battery — will die when charge runs out.

### Frigate Behaviors

#### `escort_lead`
Sweep back and forth along the shipping lanes. The convoy anchor point.
- Follow `LANE_OUTBOUND` waypoints, then reverse onto `LANE_INBOUND`, repeat
- Count tankers within 1500u (autocannon range) behind:
  - 3+ tankers: cruise at 50% throttle (12.5 u/s)
  - <3 tankers: crawl at 10% throttle (2.5 u/s) — near-stationary, waiting

**Emergent effect:** The escort_lead self-regulates its speed based on the convoy it's
protecting. If tankers fall behind (sunk, slowed, or just spawned far away), the frigate
nearly stops and waits. Once enough tankers catch up, it resumes cruising. The 1500u
detection range matches autocannon range — the frigate only counts tankers it can
actually protect.

#### `escort_follow`
Trail behind an `escort_lead` at ~800u, providing rear protection for the convoy.
- Detect escort_lead within 1500u (any direction, not just ahead)
- Throttle based on distance to escort_lead:
  - <400u: 30% throttle (too close, fall back)
  - 400–800u: 50% throttle (match escort_lead speed)
  - \>800u: full throttle (catch up)
- If no escort_lead nearby, fall back to `escort` behavior

**Emergent effect:** The escort_follow settles ~800u behind the escort_lead, which
puts it behind/among the tanker cluster (tankers are 200–500u behind the lead). Its
autocannon covers 1500u, so it protects the rear tankers that the escort_lead can't
reach. Two frigates, one simple following rule each, create overlapping fields of fire.

#### `escort`
Free-roaming tanker guardian. Finds the nearest tanker in the danger zone and orbits it.
- Acquire nearest alive tanker in X range 50000–110000
- If far: head toward it (uses lane waypoints to avoid islands)
- If close (<1000u): orbit clockwise at 500u radius
- If no tanker: head toward strait center (uses lane waypoints if far)

#### `west_strait_qrf` / `east_strait_qrf`
Quick Reaction Force. Patrol between two fixed points; engage enemies that enter the zone.
- Sweep between patrol point A and B at 70% throttle
- Switch direction when within 1000u of current target
- If any enemy enters within 5000u of either patrol point: break patrol, intercept at full throttle
- When far from patrol area (>5000u): use shipping lane waypoints to navigate safely

### The Convoy as an Emergent System

No single behavior knows about "the convoy." The formation emerges from three
independent rules interacting:

1. **escort_lead** crawls until tankers are nearby, then cruises at 12.5 u/s
2. **follow_escort_lead tankers** chase the escort_lead and slow down as they approach
3. **escort_follow** trails the escort_lead at a fixed offset

The result: a tight group where the escort_lead is at front, tankers cluster 200–500u
behind (within autocannon range), and the escort_follow covers the rear. If a tanker is
sunk, the escort_lead detects fewer tankers behind it, slows down, and waits for
replacements. If the escort_follow is destroyed, nothing changes for the tankers — they
still follow the lead. The system degrades gracefully because no unit depends on the
others to function.

## Shared Systems (Applied After All Behaviors)

### Lane Navigation
When navigating to a distant target (>5000u), frigates follow shipping lane waypoints
instead of bee-lining. `_find_lane_waypoint()` picks the nearest waypoint that makes
progress toward the target. This routes frigates through the safe shipping lanes rather
than across islands.

### Exclusion Zones
Rectangular keep-out areas (currently: north of Qeshm Island). If a frigate enters one,
it steers toward the nearest shipping lane waypoint via `_find_lane_waypoint()`. Applied
*before* land avoidance so that land avoidance can override with "go around" if the
escape path crosses an island.

### Land Avoidance
Seven probes at 0/+-20/+-40/+-60 degrees from heading, reaching `size*10 + speed*8`
units ahead (capped at 1500u to avoid detecting both coasts of the strait). When land is
detected, the behavior's rudder is overridden (not adjusted) — `min/max` ensures a hard
turn regardless of what the behavior wants. Forward land also cuts throttle to 30%.
**Highest priority** — applied last, after all other systems.

### Friendly Vessel Avoidance
Ships steer away from nearby same-faction vessels ahead of them. Cross-product
determines which side; strength scales with proximity. Applied as a rudder adjustment
(additive), not an override.

### Grounding
Ships on land are pushed toward the nearest water, slowed, and accumulate hull breaches
after a short grace period (3 ticks). Breaches cause progressive flooding via the physics
system. The grounding counter persists through brief off-land oscillations (20-tick
cooldown), so a ship stuck at a coastline will eventually sink.
