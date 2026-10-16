-- AI tuning constants — single source of truth for both hosts (server + playground).
-- Read live each tick, so hosts may mutate values at runtime (dev panels, experiments).

local config = {
	danger = {
		-- Seconds a scent stays active; strength decays linearly to zero.
		duration = 60.0,
	},

	coordination = {
		-- Seconds between group decisions (forming convoys, assigning escorts,
		-- mustering packs). Behaviors carry the decisions out every tick.
		interval = 1.0,
	},

	convoy = {
		-- A forming convoy sails once it has min_size ships, or after
		-- muster_timeout seconds with fewer...
		min_size = 3,
		max_size = 6,
		muster_timeout = 180.0,
		-- ...and once this many of its escorts are within escort_ready_range,
		-- or after escort_timeout seconds without them.
		escorts_to_sail = 1,
		escort_ready_range = 2500.0,
		escort_timeout = 300.0,
		-- A tanker under way without a convoy joins one sailing this close.
		join_range = 3000.0,
		-- Distance between ships in the column.
		spacing = 700.0,
		-- Lead ship's speed as a fraction of top speed: leaves the ships
		-- behind room to close up.
		cruise_speed = 0.9,
		-- Speed change (units/s) per unit of gap error.
		gap_gain = 0.02,
		-- A ship slows for the one behind once it falls this many spacings back.
		slack = 1.5,
		-- Further back than this, a ship has fallen out and the column goes on.
		straggler_range = 4000.0,
		-- Below this speed a tanker at the start of its route is at anchor.
		anchored_speed = 0.5,
	},

	tanker = {
		-- Brake when a tanker ahead is within this distance.
		brake_range = 400.0,
		-- Min throttle when braking behind another tanker.
		brake_min_throttle = 0.4,
		-- How far tankers sense danger scent.
		danger_range = 3000.0,
		-- Rudder bias strength when avoiding danger.
		danger_rudder = 0.3,
	},

	escort = {
		-- Escorts wanted per convoy: one per this many ships, at most max_per_convoy.
		ships_per_escort = 3,
		max_per_convoy = 2,
		-- Distance to a forming convoy counts this many times over when
		-- assigning: convoys at sea are exposed, forming ones are at anchor.
		forming_cost = 2.0,
		-- Station abeam the convoy: offset from the ship, and closing speed
		-- (units/s) per unit away from the station.
		station_offset = 800.0,
		station_gain = 0.02,
		-- Minimum throttle on station: rudders need propeller wash to turn.
		steerage_throttle = 0.1,
		-- Beyond this from station, close at full speed.
		catch_up_range = 3000.0,
		-- Drive at surface threats this close to the convoy, while within
		-- leash of the convoy's centre.
		defend_range = 3000.0,
		leash = 5000.0,
		-- Spare frigates: danger attraction, frigate-frigate repulsion, patrol.
		danger_range = 25000.0,
		repel_range = 2000.0,
		weight_danger = 1.0,
		weight_repel = 0.5,
		idle_throttle = 0.7,
	},

	pack = {
		-- Rested boats muster within muster_range of a home. A pack sails with
		-- min_size to max_size boats; a lone boat goes after lone_wait seconds.
		min_size = 2,
		max_size = 4,
		muster_range = 8000.0,
		lone_wait = 60.0,
		-- Stamina to count as rested. Well above withdraw_stamina, so boats
		-- recharge fully at home rather than turning straight back out.
		ready_stamina = 0.95,
		withdraw_stamina = 0.3,
		-- Prey: tankers within hunt_range of the pack, none with a frigate
		-- inside guarded_range.
		hunt_range = 15000.0,
		guarded_range = 3000.0,
		-- Withdraw (or find other prey) once a frigate is this close to the
		-- prey or the pack. Below guarded_range so the choice doesn't flicker.
		break_off_range = 2500.0,
		-- Gathering at the muster point ends when every boat is within
		-- gather_radius, or after gather_timeout seconds.
		gather_radius = 1500.0,
		gather_timeout = 45.0,
		-- Boats close on points approach_radius from the prey, spread_angle
		-- radians apart around it, then run in once inside strike_range.
		approach_radius = 1200.0,
		spread_angle = 0.8,
		strike_range = 1500.0,
	},

	speedboat = {
		-- Bow gun range is 200u; start the attack run from a little further.
		attack_range = 300.0,
		-- Flee inside frigate gun range (autocannon is 1500u).
		evasion_range = 1500.0,
		-- Collision spacing between boats.
		repel_range = 300.0,
		-- Stamina: drains while away from home (faster on an attack run),
		-- recharges within home_radius of a home.
		stamina_drain = 0.003,
		stamina_drain_attack = 0.02,
		stamina_recharge = 0.03,
		home_radius = 1500.0,
	},

	shahed = {
		repel_range = 1000.0,
	},

	quadcopter = {
		-- FPV camera, better optics than shahed.
		visual_range = 8000.0,
		repel_range = 500.0,
	},

	drones = {
		repel_weight = 0.4,
		-- Score bonus for current target (prevents oscillation).
		target_stickiness = 0.5,
	},

	avoidance = {
		vessel_factor = 0.8,
		vessel_strength = 0.5,
		land_strength = 0.8,
		exclusion_buffer = 2000.0,
	},

	nav = {
		-- Beyond this, navigate via lane waypoints instead of straight lines.
		transit_dist = 5000.0,
		waypoint_advance_dist = 500.0,
		-- Holding position (at anchor, at home): drift freely this close to
		-- the spot, motor back at hold_throttle from further away.
		hold_radius = 400.0,
		hold_throttle = 0.1,
	},
}

return config
