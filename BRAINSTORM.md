## Initial thoughts

I want to create a multiple player online game with a similar feel to `https://github.com/gregology/tank` (code base available in `~/src/tank`).
Tank currenlty includes the following vehicles:
 - Heavy tank
 - Quadcopter kamikaze drone
 - Self propelled Gun
 - Infantry fighting vehicles

The new game will include these vehicles and lots more.
It will be based on the current Iran / US war, specifically around the blocking of the Strait of Hormuz.
The maps will be fairly large and include the Strait of Hormuz and some of the Persian Gulf and the Gulf of Oman.
We will need to determine a reasonable scale, maybe 1/50 in size given the vehicles we're using.
We will include new vehicles like:
 - Amphibious Combat Vehicle (model on the AAV-P7/A1)
 - Frigate (model on US frigate)
 - Oil tanker
 - Long range kamikaze drones (model on the Shahed)
 - Long range Loitering drones (model on MQ-9 Reaper)
 - Helicopters (model on a sea hawk)
 - Speedboats (model on the Taregh-class speedboat)
 - Rocket systems (model on Fajr-5)
 - Mine laying boats (model on small civilian boats)
 - Mine sweeper (model on NATO mine sweeper vessel)
 - US military bases (In Bahrain and Qatar)

Future vehicles:
 - Aircraft carrier (model on a US carrier)
 - Fighter jets (model on a F35)
 - SAM systems (model on Khordad 15)
 - Submarines (model of US attack submarines)

The game play will be:
 - Oil tanker (try to get though the Strait of Hormuz without being destroyed)
 - Iran (try and destroy oil tankers and US vehicles protecting the oil tankers)
 - US (try and protect the oil tankers and destroy any Iranian targets of opportunity)

Friendly fire is possible.

This will be an online multiple player game.
The vehicles will be bots.
When a human joins they will take over from one of the bots.
Humans do not get to choose which team they are on, humans are just randomly assigned to a vehicle when they spawn / respawn.

Deliberate decisions:
 - none of the targets will be individual humans, always vehicles. I don't want to show humans being killed just vehicles destroyed.
 - Players can't choose their team, they are randomly asigned when they spawn / respawn
 - Player's don't have usernames or anything distinguising features.
 - Bots are playing when there are no humans in the game so the game is always active and humans can always join and have fun.

We will want a playground so that I can:
 - tweak settings like hp or damage etc
 - tweak vehicle models
 - tweak how vehicles move
 - see how different AI personalities interact
 - see how different AI personalities navigate obstacals
 - etc

This will make it easier for me to give quick feedback.

The decisions we'll need to make are:
 - front end technology (this will be an online browser based game with no login, just visit the site and you're in the game)
 - back end stack (I have a perference for Python based backend but I'm flexible)
 - How the Oil tankers act (what happens when they get to the other side? Maybe when they get far into the Gulf of Oman they empty and turn around and when they get into the Persian Gulf they need to get to a specific port?)
 - vehicle attributes, hp, damage types, speed, how damage affects speeds, turning, etc.
 - weapon attributes, some vehicles fire weapons, what range can they hit, if a vehicle fires a long range weapon like a drone, what is the visual. Does the screen follow the drone and control it? Do the controls get inteferred with when it gets close to a frigate (RF jamming, maybe the controls stop working and it just continues straight like it's being jammed?)
 - For inprecie weapons like rockets, how do we visualise firing that? Maybe using the mini map
 - ships like frigate have lots of situational awareness, how can we represent that in the game? Maybe arrows around the screen showing incoming targets and the mini map having details of friendlies and enemies

If the game is full then maybe the waiting players should be in view mode. Or maybe there should also be a view mode where you can just watch. This would be useful if you're not a gamer and you just want to see how things would look.

We should include details about how new oil tankers spawn as we'll need to replace the ones that are destroyed. They'll spawn at a port in the Gulf of Persia or in the Gulf of Omar on the map edge as if they had just arrived in the area.

This is a larger project. The intent today isn't to plan everything, it's to chat and align. The first step will be crafting a project description followed by building the playground so we can start designing the models. Then we'll decide on technology and interfaces. And then start work on the back end driving the game.

Let's just start with questions. What questions do you have of me before we start crafting an initial project description? I really want to slow you down and make sure we're building something that is extensible and maintainable. So the project description should focus on the why of the project, not the how. We don't know how yet, we'll work that out as we go.

This will also be a completely new repo / project. I'm just starting the conversation here because there is some shared context on the style of game we'll be building.

## Follow up questions and answers

> 1. The tank game is isometric pixel-art. Naval warfare over a large sea area feels different - are you thinking top-down (like a strategy/radar view), isometric again, or something else? Top-down might suit the "lots of water, big map" nature better and make the minimap/situational awareness features more natural.

Isometric again.

> 2. What level of visual fidelity are you after? The tank game's charm is its low-fi procedural graphics with no assets. Same approach here, or are you open to simple sprite assets for the vehicles?

I would like to use simple sprite assets for the vehicles and terrain for this new game.

> 3. The Strait of Hormuz is ~54km at its narrowest point. At 1/50 scale that's still ~1km of game-world. When you say 1/50, do you mean the vehicles are 1/50 of real size relative to a real-geography map? Or that the whole map (geography + vehicles) is compressed so it "feels" right gameplay-wise? I think what matters is: how long should it take a tanker to traverse the strait in real time? That drives everything else.

That the whole map (geography + vehicles) is compressed so it "feels" right gameplay-wise. So the vehicles will be much larger relative to the real-geography. But then the Oil tankers won't take hours to traverse the strait. I'm open to suggestions and we can play around this these values, speed of vehicles, size of geography, side of vehicles in the playground to get the feeling right.

> 4. Real coastline geography (traced from actual maps) or "inspired by" (recognisable shape but simplified for gameplay)? Real coastlines have gameplay implications - chokepoints, island cover, port locations.

Recognisable shape but simplified for gameplay. But trying to make it as realistic as possible so it's obvious the location the game is taking place in.

> 5. Is the map static (same every game) or generated? Given it's a real geography, I'd assume static with hand-placed landmarks, but want to confirm.

Static map.

> 6. You describe 3 factions: Oil Tankers, Iran, US. When a human spawns randomly, can they end up as an oil tanker? That's a very different experience (survive and navigate) vs. combat vehicles. Is that intentional - part of the fun is not knowing what you'll get?

Exactly, that is intentional. It's also commentary on the fact that soldiers rarely choose the side they fight for, they're born in a country and then fight for that country's army. And the oil tanker crew are just civilians stuck in the middle. This is as much a game as a commentary about war and how pointless this current war in Iran is. The game play for the oil tankers is just to survive, staying close to the frigete ships etc for protection.

> 7. What's the rough ratio of vehicles per faction in a typical game state? e.g., 5 tankers in transit, 15 Iranian vehicles, 10 US vehicles? This affects how likely a human is to land on each side.

There should be lots more vehicles. I'm hoping to make this a MMORPG. As a rough estimate I think 20 tankers, 40 US vehicles (~5 Frigates), and 80 Iranian vehicles. Again, we will need to see how this feels in the playground to get a good sense of the actual numbers. But having ~100 online players is the goal.

> 8. When you say "friendly fire is possible" - does that include Iran accidentally hitting Iran, US hitting US, AND Iran/US hitting oil tankers (which aren't on either "combat" team)?

Yes, all types of friendly fire incidents are possible. Again, we're using this game as a tool to demonstrate how silly and dangerous the Iran war is.
                                                      
> 9. Is this one persistent world that runs 24/7 (like an MMO), or does it reset periodically? If persistent, what does "winning" look like - is there a score ticker (tankers delivered vs. tankers sunk)?

The world is persistent with the option to reset when I choose. There is a ticker score of (tankers delivered vs. tankers sunk) plus military assets destroyed (with an estimated valuation).

> 10. When a human's vehicle is destroyed, they respawn as a random vehicle on a random team. Is there any continuity for a human player between lives, or is each spawn a completely fresh slate? (No score tracking, no "you've been playing for X minutes"?)

No continuity between lives for a human player by design.

> 11. How many concurrent human players are you designing for? 10? 50? 200? This massively affects backend architecture.

Lets design for 200.

> 12. The tank game has a very direct control model (WASD + turret). Naval vessels are sluggish - a frigate doesn't turn on a dime. Are you aiming for realistic-feeling movement (slow turns, momentum, inertia) or arcade-snappy controls? Slow/realistic rewards planning but can feel frustrating. A drone or speedboat would feel very different from a frigate.

Slow / realistic especially for the tankers which are not very maneuverable at all in reality. They should be easy targets for speedboat attacks. 

> 13. Some vehicles you listed are fundamentally different control paradigms:
> - Direct control: speedboat, frigate, tanker, ACV (you drive it)
> - Launched/guided: kamikaze drone, loitering drone (you guide it to a target?)
> - Indirect fire: rocket systems (you aim at coordinates?)
> - Passive/deploy: mine layer (you drop mines along a path?)
> 
> Is the intent that ALL of these are playable by humans? Or are some bot-only?

All playable by humans with various gameplay but may be semi-bot controlled. For instance, maybe the kamikaze drone is launched from a truck. You start by driving the truck around but once you launch the kamikaze drone you control the drone. In the mean time, the truck is controlled by a bot, drives around etc. Then when you hit your target you return to the truck and take over control again. This would prevent a truck from being a sitting duck once it fires.

> 14. When you picture the playground, is it: (a) a single-player sandbox where you can spawn any vehicle, drive it around, tweak stats in a panel, and see the effects immediately - like a dev tool? Or (b) more like a small scenario runner where you set up a situation (e.g., 3 speedboats vs 1 frigate) and watch/play it out?

Ideally the ability to do both of those things.

> 15. Should the playground use the same rendering as the final game, or is it okay for it to be simpler (e.g., colored shapes on a plain blue background) so we can iterate on mechanics before investing in visuals?

The playground should help inform the visuals. So it should render as the final game does.
                                                          
> 16. You've made a clear and good decision about no human casualties - vehicles only. Are there other guardrails you want in the project description? For example: no national flags on vehicles? No political messaging in the UI? Neutral faction labels instead of "Iran" / "US"? I want to understand where the line is for the public-facing game.

We can include Iran and US and flags. We're trying to articulate that this whole war is silly and pointless. We don't want to be on the nose so no overte political messaging in the UI. The game should speak for itself and demonstrate the pointlessness of this war.

> 17. Oil tanker routes: You mentioned tankers going through the strait. Should they follow a specific shipping lane (like the real Traffic Separation Scheme in the strait), or just navigate from point A to point B? And where are points A and B - e.g., a port in the Persian Gulf (Kuwait/Saudi Arabia?) to open water in the Gulf of Oman, and back?

We should include a channel and any realistic hazards like shoals etc. And the bots should use the channel. But we would expect humans to try and avoid the channel to prevent being attacked directly. They shoud take damage and sink if they hit natural hazards, other tankers, etc as they are in reality quite fragile. The should go from a port in the Persian Gulf to the edge of the map in the Gulf of Oman (maybe we'll make the round edge of the map) and that's success. In reality these tankers go all over the world so just having them cross the edge of the map could be considered "finished" and a new empty tanker going the other direction would take it's place.

> 18. Iranian vehicle spawn locations: Iran controls the northern shore of the strait plus islands like Qeshm, Hormuz, Larak, and Abu Musa. Should Iranian vehicles spawn from these coastal positions and islands? This is strategically interesting because the islands sit right in the shipping lanes.

Yes, the Iranian vehicles should spawn on the Iranian coast and islands.

> 19. US vehicle spawn locations: In reality the US operates from carriers and bases in Bahrain/Qatar. For this game, should US vehicles spawn from a carrier group or from off-map (representing bases outside the play area)? Or both?

US vehicles should spawn from bases in Bahrain/Qatar and the edge of the map in the Gulf of Oman (as if they had just arrived by sea).

> 20. The ticker/scoreboard: You mentioned tankers delivered vs sunk, plus military assets destroyed with estimated valuations. Should this be visible to all players at all times (like a persistent war cost counter)? That's a powerful anti-war statement - watching the dollar/human cost tick up while you play.

Yes, persistent war cost counter that is visable to all players.

> 21. Vehicle destruction visuals: When a vehicle is destroyed, what happens? Explosion and sink/disappear? Leave wreckage? Oil spills from tankers? Wreckage and oil spills could reinforce the anti-war theme and also serve as gameplay obstacles.

Explosion and sink but leave wreckage under water for a while (configurable but maybe 5 mins). Also leave oil spills from tankers.

> 22. Camera: In the tank game each player has their own viewport following their vehicle. Same here - camera follows your vehicle with the ability to zoom? Given the scale differences (a speedboat vs a tanker vs a frigate), should zoom level adjust per vehicle type, or should the player control zoom?

Player should control zoom with a sensible default.

> 23. Time of day / weather: The strait has intense heat, sandstorms, and night operations matter tactically (drones are harder to spot at night, etc.). Is this something you want eventually, or keep it simple with a single lighting condition?

Includ night and day matching the actual time of day in the strait.

> 24. Player experience on join: You visit the site - what do you see first? Immediately spawned into a vehicle? A brief spectator view of the action before spawning? A minimal "click to join" screen? I'm thinking about the zero-friction entry point

Immediately spawned into a vehicle (or waiting if the server is full).

> 25. Player count visibility: Should players know how many other humans are in the game? Or is it deliberately ambiguous whether you're fighting humans or bots? (The latter reinforces the "you don't choose your war" theme - you can't even tell if your enemies are real people.)

Maybe we can have a `status` page that shows the current details. I think it's useful to know how many folks are in the game. Let's expose that detail in the game's UI.

> 26. Communication: Can players communicate with each other at all? Text chat? Pings? Or complete silence - you're alone in your vehicle with no way to coordinate? (Silence is thematically powerful but might frustrate players wanting to coordinate defense.)

Let's start with no communication but we can introduce this later. I'm thinking it would be really useful for oil tankers to be able to coordinate with US military to safe passage and Iranian miliary being able to tell the oil tankers to turn around.

> 27. Playground scope: Should the playground work on the full Strait of Hormuz map from day one, or start with a small test area (a patch of sea with a couple of islands) and we add the full map later? Starting small lets us iterate on vehicle mechanics faster.

Start with the full map. It will infer the size of the vehicles so having it all together makes sense.

> 28. Playground controls panel: Are you comfortable with a developer-style panel (sliders, number inputs, dropdowns) on the side of the screen? Something like dat.GUI or a custom panel where you can adjust vehicle stats, spawn entities, toggle AI on/off, etc.?
