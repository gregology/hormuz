-- AI tuning constants — single source of truth for both hosts (server + playground).
-- Read live each tick, so hosts may mutate values at runtime (dev panels, experiments).

local config = {
	danger = {
		-- Seconds a scent stays active; strength decays linearly to zero.
		duration = 60.0,
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
		-- Frigates prefer to be this far from their assigned tanker.
		offset_dist = 800.0,
		-- Danger attraction range — senses attacks across most of the lane.
		danger_range = 25000.0,
		-- Frigate-frigate repulsion range.
		repel_range = 2000.0,
		-- Steering weights (summed, then clamped to [-1, 1]).
		weight_presence = 0.6,
		weight_danger = 1.0,
		weight_repel = 0.5,
		-- Cruise throttle when near tankers / patrolling.
		cruise_throttle = 0.6,
		idle_throttle = 0.7,
		-- Escort pressure scoring: (1+pressure)^power so unescorted far
		-- tankers outscore crowded nearby ones.
		pressure_power = 3,
		-- Frigates within this radius of a tanker count as soft coverage.
		coverage_radius = 6000.0,
		-- Threat proximity scoring radius and per-threat score multiplier.
		threat_radius = 5000.0,
		threat_weight = 2.0,
	},

	speedboat = {
		-- Bow gun range is 200u; approach from further.
		visual_range = 8000.0,
		-- Transition to attack run (matches bow gun range).
		attack_range = 300.0,
		-- Rush to ongoing attacks within this range.
		danger_range = 6000.0,
		weight_danger = 0.6,
		-- Flee well before frigate weapons range (autocannon is 1500u).
		evasion_range = 1500.0,
		evasion_weight = 1.5,
		-- Avoid tankers with a frigate within this distance.
		frigate_proximity = 4000.0,
		-- Pack repulsion (tighter than drones — they coordinate closely).
		repel_range = 300.0,
		-- Stamina: foraging wasp model — hunt while bold, retreat to recharge.
		stamina_drain = 0.015, -- per second while hunting (~45s aggression after transit)
		stamina_drain_attack = 0.04, -- per second in attack range
		stamina_recharge = 0.1, -- per second near spawn (~7s to refuel)
		stamina_threshold = 0.3, -- retreat below this
		home_radius = 1500.0, -- distance from spawn to start recharging
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
	},
}

return config
