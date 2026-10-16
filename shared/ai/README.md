# Bot AI — Groups that Decide, Bots that Steer

The AI runs in two layers each tick (`main.lua`):

1. **Coordinators** (`coordination/`), about once a second, decide *groups*:
   which tankers form a convoy and when it sails, which frigate escorts which
   convoy, which speedboats hunt together and what. They write each bot's
   part to its bot state (`bot.group`, `bot.target`).
2. **Behaviors** (`behaviors/`), every tick, carry that part out with local
   steering: hold at anchor, keep station in the column, stay abeam the
   convoy, close on the prey from one side. Ships then get the shared
   collision-avoidance post-pass (land, exclusion zones, friendly vessels).

Big decisions live in one place and stay put until something changes, so a
frigate commits to its convoy instead of re-picking a tanker every tick, and
a pack attacks together instead of each boat chasing its own target.

## Group state

Group records (`lib/groups.lua`) live in the VM. Membership lives on each bot
as `bot.group` (a convoy id, the id of the convoy a frigate escorts, or a pack
id; 0 = none), which the hosts persist with the rest of the bot state
(`BotControl` on the server, `AIBotState` in the playground). When the server
rebuilds the VM on a script change, the records are gone but the members
still carry their ids: each coordinator restores a missing record from its
members the next time it runs, and `groups.reserve_ids` keeps new ids clear
of surviving ones. Only timers (how long a convoy has waited) restart.

Coordinators visit groups and bots in id order so both hosts make identical
decisions (`contract_fixtures.json`).

## Convoys (`coordination/convoys.lua`, `behaviors/tanker_transit.lua`)

- **Forming.** A tanker at the start of its route (waypoint index 0: just
  spawned, or just turned round at its destination) joins the forming convoy
  for its destination, up to `convoy.max_size` ships, and holds where it
  joined. Holding means drifting within `nav.hold_radius` and motoring back
  at `nav.hold_throttle` when pushed further: a ship with its engine stopped
  still moves (slope forces, collisions), and one drifted onto Larak Island.
- **Sailing.** A forming convoy sails once it has `convoy.min_size` ships
  (or has waited `convoy.muster_timeout`) **and** `convoy.escorts_to_sail` of
  its escorts are within `convoy.escort_ready_range`. If no escort comes for
  `convoy.escort_timeout`, it sails unprotected rather than stopping traffic
  for good (every frigate sunk, or all taken by players).
- **In column.** Ships are ordered by progress along the route; each follows
  the route's waypoints and sets its speed from the ships either side: close
  to `convoy.spacing` behind the ship ahead, and slow for the ship behind once
  it falls `convoy.slack` spacings back. The lead ship cruises at
  `convoy.cruise_speed` of top speed, leaving the others room to close up. A
  ship more than `convoy.straggler_range` back has fallen out (aground,
  crippled); the column goes on and it follows at full speed. Tankers still
  brake for any tanker close ahead and drift away from danger scent.
- **Under way alone.** A tanker past the start of its route without a convoy
  (a player handed it back) joins a sailing convoy within `convoy.join_range`,
  or sails on as a convoy of one so it can still be escorted.
- **Arrival.** The host turns a tanker round at its destination (new
  destination, waypoint 0); it leaves its convoy and joins the next one
  forming there. An empty convoy is removed.

## Escorts (`coordination/escorts.lua`, `behaviors/escort.lua`)

- **Assignment.** Each convoy wants one escort per `escort.ships_per_escort`
  ships, at most `escort.max_per_convoy`. Vacancies are filled nearest frigate
  first; convoys at sea come before convoys still forming (their distance
  counts `escort.forming_cost` times over). A frigate keeps its convoy until
  the convoy arrives or is sunk; if the convoy shrinks, the furthest escorts
  are released.
- **Station.** Escorts spread along the column, abeam a ship at
  `escort.station_offset`, the first on the side facing the nearest speedboat
  base and the next on the other side. A station on land moves to the far
  side, or onto the lane ahead. The frigate matches the ship's velocity plus
  a correction toward its station (`escort.station_gain`), so it closes from
  any side and settles parallel; beyond `escort.catch_up_range` it closes at
  full speed via lane waypoints.
- **Defence.** A surface threat (from the coalition threat picture) within
  `escort.defend_range` of the convoy draws the escort onto it, as long as it
  stays within `escort.leash` of the convoy. Drones are left to the
  autocannon and jammer.
- **Spare frigates** (no convoy needs them) rush to danger scent within
  `escort.danger_range`, keep `escort.repel_range` from other frigates, and
  otherwise patrol the least-covered of five anchors along the lane.

## Speedboat packs (`coordination/packs.lua`, `behaviors/swarm_attack.lua`)

- **Stamina.** Drains away from home (faster within attack range of the
  target), recharges within `speedboat.home_radius` of a home. A boat with no
  pack holds near its home (see Convoys for holding).
- **Mustering.** Boats at home with at least `pack.ready_stamina` are rested.
  A pack musters at the home with the most rested boats within
  `pack.muster_range`: between `pack.min_size` and `pack.max_size` of them,
  or a single boat that has waited `pack.lone_wait`. Resting until nearly
  full, well above `pack.withdraw_stamina`, is what stops boats turning
  straight back out the moment they get home.
- **Prey.** The pack only forms if no frigate is within
  `pack.break_off_range` of the muster point (it would withdraw at once) and
  there is prey: a tanker within
  `pack.hunt_range` with no frigate inside `pack.guarded_range`, scored by
  frigate-free distance per unit of travel (exposed and close beats exposed
  and far).
- **Hunting.** Boats gather at the muster point (`pack.gather_radius`, or
  `pack.gather_timeout`), then each closes on a point `pack.approach_radius`
  from the prey at its own bearing, `pack.spread_angle` apart, so the pack
  arrives from several sides. Inside `pack.strike_range` they run straight
  in, then alongside the tanker to keep it in the bow gun's arc.
- **Withdrawing.** If the prey sinks or a frigate comes within
  `pack.break_off_range` of it, the pack picks other prey or withdraws; it
  also withdraws when a frigate closes on the pack or its average stamina
  falls below `pack.withdraw_stamina`. Boats leave the pack as they reach
  home.
- **Evasion.** A boat with a frigate inside `speedboat.evasion_range` (the
  autocannon's range) turns directly away at full throttle, whatever its
  pack is doing.

## Drones

Drones act alone; their swarm behaviour comes from shared target pressure.

1. **Target pressure avoidance** — score each potential target by
   `1 / (distance² × (1 + drones_already_targeting_it))`. Pick the highest-scoring
   target. The current target gets a stickiness bonus (`drones.target_stickiness`)
   to prevent oscillation, but if pressure is high enough the drone switches.
   Counts are updated live during the dispatch loop so each successive drone sees
   accurate pressure.
2. **Drone-drone repulsion** — steer away from nearby same-type drones. This
   diversifies approach angles on the same target.

`shahed_intercept` targets tankers at any range and flies straight while jammed
(within `JAM_RADIUS` of a frigate). `quadcopter_intercept` targets tankers and
frigates within `quadcopter.visual_range`, is immune to jamming, and heads for
the strait centre when it sees nothing.

## Radar Detection Model

Detection range between any two vehicles is computed from two YAML properties:

- **`radar_cross_section`** (on every vehicle): physical radar reflectivity in m².
  Larger = easier to detect. Oil tanker: 50,000. Quadcopter: 0.01.
- **`radar.sensitivity`** (on radar-equipped vehicles only): quality of the radar
  system. Higher = can resolve smaller cross sections at greater range.
- **`radar.max_range`** (on radar-equipped vehicles): hard ceiling from earth
  curvature / radar horizon. Frigate: 20,000u. Tanker: 3,000u.

**Formula** (computed at codegen time):
```
detection_range(observer, target) = min(max_range, sensitivity × rcs^0.25)
```

The `rcs^0.25` exponent comes from the real radar range equation. Codegen produces
a `DETECTION_RANGE[observer_type][target_type]` lookup table, injected into the VM
as `gamedata.detection_ranges`.

## Coalition Threat Picture

`main.lua` pools radar detections across US and civilian vessels each tick: any
Iranian vessel within `DETECTION_RANGE[observer][target]` of any of them is in
`ctx.threats` once. A tanker's nav radar picking up a speedboat tells every
frigate. Escorts use it to find surface threats near their convoy.

## Danger Scent

Hosts call `ai_add_scent(x, y)` for hits (kamikaze impacts, gunfire) and
sinkings. Scents live in the VM, decay linearly to zero over `danger.duration`
seconds and are lost on a VM rebuild. Spare frigates rush toward the nearest one;
tankers under way drift away from it.

## Collision-Avoidance Post-Pass (ships only)

Applied after every behavior, in this order:

1. **Friendly vessels** — steer away from same-faction ships close ahead
   (added to the behavior's rudder).
2. **Land** — seven probes up to ±60° from the heading; land on either side
   overrides the rudder with a hard turn away, land dead ahead also cuts
   throttle to 30%.
3. **Exclusion zones** — polygons from `shared/map.yaml`, each listing the
   behaviors it applies to. Near or inside one, the rudder blends toward the
   ship's route (tankers) or the lane toward the strait centre; inside one,
   throttle is at least 50%. Ships merely near a zone are not pushed, so a
   convoy at anchor beside one stays at anchor.

## Adding to the AI

- **A behavior** for a new vehicle: a file in `behaviors/`, registered in
  `main.lua`'s `behaviors` table. It reads its group (if any) from
  `groups.get(e.bot.group)` and writes `e.bot.throttle` / `e.bot.rudder`.
- **A group kind** (e.g. minesweepers leading convoys): a file in
  `coordination/` with a `coordinate(ctx)` function, added to `main.lua`'s
  `coordinators` list after any coordinator it reads from. Keep membership on
  the bots (`bot.group`) and restore missing records from members, so a VM
  rebuild loses nothing.
- **Tuning:** every constant is in `config.lua`, live-editable from the
  playground's AI panel. After an intentional behavior change, regenerate the
  parity fixtures (`UPDATE_AI_FIXTURES=1 pnpm --filter @hormuz/client test -- contract`)
  and run the server tests.
