# Hormuz

## What This Is

Hormuz is a persistent multiplayer browser game set in the Strait of Hormuz during a fictional escalation of the Iran–US conflict. Players control military vehicles, civilian oil tankers, and autonomous weapons systems in an ongoing struggle over one of the world's most critical shipping lanes.

The game runs 24/7. There is no login, no account, no team selection. You visit the URL and you're immediately placed inside a vehicle — maybe an oil tanker trying to survive, maybe an Iranian speedboat attacking a convoy, maybe a US frigate defending one. You don't choose. When your vehicle is destroyed, you respawn as something else, possibly on a different side. Between human players, bots keep the world alive and the war grinding on.

A persistent cost-of-war counter tallies every destroyed vehicle — tankers sunk, frigates lost, drones expended — with estimated real-world dollar valuations. It never resets. It only goes up.

## Why This Exists

This is an anti-war game disguised as a war game.

The Iran–US conflict over the Strait of Hormuz is pointless. Oil tanker crews are civilians caught between two militaries. Soldiers on both sides didn't choose which country they were born in. Billions of dollars of hardware gets destroyed to control a shipping lane. The game makes this felt, not stated.

The design choices are the commentary:

- **You don't pick your side.** You're randomly assigned to Iran, the US, or an oil tanker. Just like real life — soldiers don't choose their nation's wars. You might spawn as an Iranian speedboat pilot attacking the convoy you were just protecting.

- **You don't pick your vehicle.** You might get a powerful frigate or a defenseless tanker. The tanker crew didn't volunteer for a war zone either.

- **Friendly fire is always on.** Missiles don't check uniforms. A rocket barrage aimed at a frigate can hit an oil tanker. A jammed drone veers into friendly forces. War is messy.

- **No human figures are ever shown.** Vehicles are destroyed, not people. But the cost counter quietly tracks what those vehicles represent.

- **The war never ends.** The counter never resets. Tankers keep sailing. Vehicles keep dying. New players join and inherit a war already in progress. The game doesn't tell you war is pointless — it shows you, over and over, every time you play.

- **No communication between players (initially).** You're alone in your vehicle. You can't coordinate, can't negotiate, can't call for help. Isolation is part of the experience. Future updates may add limited communication — tankers requesting escort, Iranian forces warning tankers to turn back — but silence is the starting point.

There is no overt political messaging in the UI. No editorializing. No pop-ups. The game speaks for itself. The flags are real, the geography is real, the vehicle models are based on real hardware. Players draw their own conclusions.

## The Setting

The map covers the Strait of Hormuz and portions of the Persian Gulf (west) and the Gulf of Oman (east). The geography is based on real coastlines — simplified for gameplay but recognisable. Key features include:

- **The Strait itself** — the narrow chokepoint between Iran and Oman, approximately 54km wide in reality, compressed to a game-playable scale
- **Shipping lanes** — based on the real Traffic Separation Scheme, with inbound and outbound channels. Includes realistic hazards: shoals, shallow water, rocks
- **Iranian coast and islands** — Qeshm, Hormuz, Larak, Abu Musa. These sit directly in or near the shipping lanes, making them strategically critical
- **Omani coast** — the southern shore of the strait
- **Persian Gulf ports** — on the western edge of the map, where tankers load
- **Gulf of Oman** — the eastern portion of the map, where tankers exit to safety and US reinforcements arrive
- **US bases** — Bahrain and Qatar, where US vehicles spawn

The map is static — the same geography every time. Time of day matches the real-world time in the Strait of Hormuz, with full day/night cycles affecting visibility and tactics.

## The Three Factions

### Oil Tankers
Massive, slow, fragile civilian vessels trying to transit the strait. They load at Persian Gulf ports, navigate the shipping channel (or risk going off-channel to avoid attacks), and aim to reach the Gulf of Oman map edge. A successful transit scores a delivery. A destroyed tanker scores a loss, leaves wreckage, and spills oil that persists as a visual scar and navigational hazard.

Bot tankers follow the shipping lanes. Human tanker players might hug the Omani coast, shelter near US escorts, or take other creative routes — but going off-channel risks running aground on shoals. Tankers that collide with hazards, other vessels, or wreckage take damage and can sink. They are not maneuverable. They are easy targets. Playing as a tanker is tense, slow, and sometimes boring — which is the point.

When a tanker successfully exits the map, an empty tanker spawns heading the other direction to take its place. Destroyed tankers are also replaced — a new tanker spawns at either a Persian Gulf port or the Gulf of Oman map edge (as if arriving from open ocean). The strait always has tankers in transit. The flow of oil never stops, no matter how many ships burn.

### Iran
The larger force numerically, operating from coastal positions and islands that sit astride the shipping lanes. Iranian vehicles are generally smaller, faster, and cheaper — speedboats, kamikaze drones, rocket systems, mine layers. The strategy is asymmetric: swarm tactics, area denial with mines, long-range harassment with drones and rockets.

Iranian vehicles spawn from the Iranian coastline and islands (Qeshm, Hormuz, Larak, Abu Musa).

### United States
A smaller but technologically superior force protecting the tanker convoys. US vehicles are expensive, powerful, and loaded with situational awareness — frigates with radar, loitering drones for surveillance, mine sweepers to clear lanes, helicopters for rapid response.

US vehicles spawn from bases in Bahrain/Qatar and from the Gulf of Oman map edge (representing arrivals by sea).

## Vehicles

Every vehicle is always controlled by either a bot or a human. When a human joins, they take over a bot's vehicle. When a human's vehicle is destroyed or they disconnect, the vehicle returns to bot control (or a new bot vehicle spawns at the appropriate location).

### Current Roster

| Vehicle | Faction | Based On | Role |
|---------|---------|----------|------|
| Oil Tanker | Civilian | Generic VLCC | Transit the strait. Slow, fragile, massive. |
| Frigate | US | US Navy frigate | Convoy escort. Powerful weapons, radar, anti-air. RF jamming disrupts nearby enemy drones. |
| Amphibious Combat Vehicle | US | AAV-P7/A1 | Operates on land and sea. Versatile but not dominant in either. |
| Helicopter | US | MH-60 Seahawk | Fast response, anti-surface. Flies over water. |
| Loitering Drone | US | MQ-9 Reaper | Long-range surveillance and precision strike. |
| Mine Sweeper | US/Coalition | NATO mine sweeper | Clears mines from shipping lanes. Lightly armed. |
| Speedboat | Iran | Taregh-class | Fast attack craft. Cheap, expendable, deadly in swarms. |
| Kamikaze Drone | Iran | Shahed-series | Launched from a truck. Player controls truck, then switches to drone after launch. Truck reverts to bot control during flight. One-way weapon. |
| Rocket System | Iran | Fajr-5 | Indirect fire from shore positions. Area denial. Imprecise. |
| Mine Layer | Iran | Civilian boat (disguised) | Deploys naval mines in shipping lanes. Looks civilian. |
| US Military Base | US | — | Fixed spawn point and defensive position in Bahrain/Qatar. |

### Future Roster

| Vehicle | Faction | Based On | Role |
|---------|---------|----------|------|
| Aircraft Carrier | US | US supercarrier | Mobile spawn point for aircraft. High-value target. |
| Fighter Jet | US | F-35 | Air superiority, strike missions. |
| SAM System | Iran | Khordad 15 | Shore-based anti-air. Denies airspace. |
| Submarine | US | Virginia-class | Stealthy. Anti-surface, intelligence gathering. |

## Vehicle Design Principles

Vehicles differ dramatically in how they feel to control:

- **Oil tankers** are sluggish, with wide turning circles and slow acceleration. Momentum matters. You commit to a heading.
- **Frigates** are powerful but not nimble. Turning takes time. Weapons have range and variety.
- **Speedboats** are fast and twitchy. They can dart in, attack, and flee. But one hit from a frigate ends them.
- **Kamikaze drones** start as a truck (direct control), then switch to an airborne drone (direct control, flies over everything). When the drone hits or is destroyed, control returns to the truck.
- **Rocket systems** use indirect fire — you aim using the minimap or a targeting overlay, not direct line of sight.
- **Mine layers** deploy mines behind them as they move. The gameplay is route planning — where to lay mines for maximum disruption.
- **Helicopters** fly over water and land, with direct control. Fast, moderate weapons, fragile.

Every vehicle has attributes that can be tuned: speed, turn rate, acceleration, HP, weapons (type, damage, range, cooldown, accuracy), and special abilities. Damage can affect performance — a damaged tanker leaks oil and slows down, a hit frigate might lose weapons systems.

## Weapons & Countermeasures

Weapons are not just "shoot and hit." Different weapon types create different gameplay:

- **Direct fire** (frigate guns, speedboat weapons, helicopter) — aim and shoot, line of sight required
- **Guided** (loitering drone) — player steers the weapon to target
- **One-way** (kamikaze drone) — player IS the weapon for its terminal phase
- **Indirect** (rocket systems) — area-of-effect, aimed via map coordinates, imprecise
- **Passive** (mines) — deployed and left, triggered by proximity
- **Countermeasures** (frigate RF jamming) — disrupts enemy drone controls within a radius, causing them to fly straight (as if jammed) instead of responding to player input

## The Player Experience

1. **You visit the URL.** No login, no account, no name.
2. **You're immediately in a vehicle.** Random faction, random vehicle type. The camera follows your vehicle in isometric view. You can zoom in and out.
3. **You play.** Controls depend on your vehicle type. The HUD shows your vehicle status, a minimap, incoming threat indicators, and the persistent war cost counter.
4. **Your vehicle is destroyed.** Explosion, wreckage sinks. If a tanker, oil spills. Brief delay, then you respawn as a completely different vehicle, possibly on a different side.
5. **You close the tab.** Your vehicle reverts to bot control. No state is saved. No score is tracked for you personally.

**Spectator mode:** Players can also choose to just watch. A free-roaming camera lets spectators pan and zoom across the map, observing the war without participating. This serves multiple purposes:
- If the server is full (200 human players), new arrivals spectate until a slot opens
- Non-gamers can visit the site and simply watch the conflict unfold
- It's a powerful way to experience the game's message — watching the war grind on from above, seeing the cost counter tick up, without the distraction of trying to survive

Spectators can switch to active play at any time (server capacity permitting). Active players can switch to spectator mode at any time (their vehicle reverts to bot control).

The game is always running. When you leave, the bots keep fighting. When you return, the war has continued without you. The cost counter is higher. More wreckage litters the strait. Nothing you did mattered — and nothing anyone else did mattered either. The war just continues.

## The Persistent World

The game world runs on a server 24/7. Bots populate all vehicles when no humans are present. The simulation continues regardless of player count.

**State that persists:**
- The war cost counter (cumulative, never resets automatically)
- Wreckage positions (decay after ~5 minutes)
- Oil spills (decay slowly)
- Mine fields (until swept or triggered)
- Current positions and states of all vehicles

**State that resets:**
- Manual admin reset only (for maintenance, rebalancing, etc.)

**Target capacity:** ~140 bot vehicles + up to 200 concurrent human players taking over bot vehicles.

## The Playground

Before building the multiplayer game, we need a development playground — a tool for designing, testing, and tuning every aspect of the game.

The playground renders using the same engine as the final game (isometric, sprite-based, full Strait of Hormuz map). It includes:

- **Sandbox mode**: Spawn any vehicle, drive it around, test controls and movement feel. Adjust vehicle stats (speed, turn rate, HP, weapon damage, etc.) via a developer panel with sliders and inputs. Changes apply in real-time.
- **Scenario mode**: Set up specific situations (e.g., "3 speedboats vs 1 frigate near Qeshm Island") and play them out or observe bot behaviour. Useful for tuning AI, weapon balance, and engagement ranges.
- **AI tuning**: Toggle bot control on/off per vehicle. Observe how different AI behaviours interact — do speedboats swarm correctly? Do tankers follow the channel? Do frigates maintain escort formations?
- **Vehicle model workshop**: Tweak sprite rendering, vehicle proportions, visual effects. See how vehicles look at different zoom levels and times of day.
- **Map inspection**: Pan and zoom freely across the full map. Check coastlines, shipping lanes, spawn points, hazard placements.

The playground is the primary development tool. Every vehicle, weapon, AI behaviour, and visual effect gets built and tested here before being deployed to the live game.

## Design Principles

1. **The game is the message.** No text tells you war is bad. The mechanics do.
2. **No human figures.** Vehicles are destroyed, never people. The cost counter implies the human toll without showing it.
3. **Zero friction entry.** Visit URL → playing. No accounts, no tutorials, no loading screens (beyond initial asset load).
4. **Every vehicle is always active.** Bots fill every seat. Humans seamlessly take over and hand back. The world is never empty.
5. **Asymmetric by design.** Iran has numbers and geography. The US has technology and firepower. Tankers have nothing but hope and a destination. The asymmetry IS the gameplay.
6. **Friendly fire is a feature.** It creates chaos, regret, and the fog of war. It's not a bug to be minimized — it's a core mechanic that reinforces the theme.
7. **Extensible vehicle system.** Adding a new vehicle should be a data definition + sprite + AI behaviour, not a rewrite. The tank game's data-driven VEHICLES config is the right pattern.
8. **The playground comes first.** We build the sandbox before we build the game. Every mechanic is tuned in isolation before it meets the multiplayer world.
