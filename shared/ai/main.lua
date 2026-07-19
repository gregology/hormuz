-- AI entry point. Hosts call compute_controls(world) once per tick.
--
-- world = {
--   time = seconds (sim time, monotonic),
--   dt = seconds,
--   entities = { -- array sorted by id, ALL alive entities (bots and players)
--     { id, type, faction, x, y, heading, speed, hp, airborne, size,
--       behavior = string|nil,       -- only for AI-controlled entities
--       bot = { throttle, rudder, stamina, waypoint_index, target, destination } },
--     ...
--   },
-- }
--
-- Returns (controls, errors):
--   controls = { { id, throttle, rudder, target, waypoint_index, stamina }, ... }
--   errors   = { "entity 7: ...", ... }  (behavior errors are isolated per entity)

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local steering = require("ai.lib.steering")

local behaviors = {
	tanker_transit = require("ai.behaviors.tanker_transit"),
	escort = require("ai.behaviors.escort"),
	swarm_attack = require("ai.behaviors.swarm_attack"),
	shahed_intercept = require("ai.behaviors.shahed_intercept"),
	quadcopter_intercept = require("ai.behaviors.quadcopter_intercept"),
}

-- ---------------------------------------------------------------------------
-- Danger scent — spatial memory of recent attack locations, decays linearly
-- ---------------------------------------------------------------------------

local scents = {}
local current_time = 0.0

local function add_scent(x, y)
	scents[#scents + 1] = { x = x, y = y, t = current_time }
end

local function prune_scents()
	local kept = {}
	for _, s in ipairs(scents) do
		if current_time - s.t < config.danger.duration then
			kept[#kept + 1] = s
		end
	end
	scents = kept
end

-- ---------------------------------------------------------------------------
-- Patrol anchors — lane endpoints + midpoints, spread idle frigates along the lane
-- ---------------------------------------------------------------------------

local patrol_anchors = {}
do
	local lane = gamedata.lanes.outbound
	patrol_anchors[#patrol_anchors + 1] = lane[1]
	local mid = math.floor(#lane / 2)
	local quarter = math.floor(#lane / 4)
	if quarter > 0 and quarter ~= mid then
		patrol_anchors[#patrol_anchors + 1] = lane[quarter + 1]
	end
	if mid > 0 then
		patrol_anchors[#patrol_anchors + 1] = lane[mid + 1]
	end
	local three_quarter = mid + quarter
	if three_quarter < #lane and three_quarter ~= mid then
		patrol_anchors[#patrol_anchors + 1] = lane[three_quarter + 1]
	end
	patrol_anchors[#patrol_anchors + 1] = lane[#lane]
end

-- Exclusion zone behavior lists → sets for membership tests
for _, zone in ipairs(gamedata.exclusion_zones) do
	local set = {}
	for _, b in ipairs(zone.behaviors) do
		set[b] = true
	end
	zone.behavior_set = set
end

-- ---------------------------------------------------------------------------
-- Threat picture — coalition radar detections pooled per tick
-- ---------------------------------------------------------------------------

local function build_threats(world)
	local threats = {}
	local seen = {}
	for _, obs in ipairs(world.entities) do
		if obs.hp > 0 and (obs.faction == "us" or obs.faction == "civilian") then
			local ranges = gamedata.detection_ranges[obs.type]
			if ranges then
				for _, tgt in ipairs(world.entities) do
					if tgt.hp > 0 and tgt.faction == "iran" and not seen[tgt.id] then
						local range = ranges[tgt.type]
						if range then
							local dx = tgt.x - obs.x
							local dy = tgt.y - obs.y
							if dx * dx + dy * dy <= range * range then
								seen[tgt.id] = true
								threats[#threats + 1] = { x = tgt.x, y = tgt.y, type = tgt.type }
							end
						end
					end
				end
			end
		end
	end
	return threats
end

-- ---------------------------------------------------------------------------
-- Collision avoidance post-pass (all non-airborne bots)
-- ---------------------------------------------------------------------------

local LAND_PROBE_ANGLES = { 0.0, -0.35, 0.35, -0.7, 0.7, -1.05, 1.05 }

local function calc_vessel_avoidance(e, ctx)
	local cfg = config.avoidance
	local cos_h = math.cos(e.heading)
	local sin_h = math.sin(e.heading)
	local adjust = 0.0
	for _, other in ipairs(ctx.ships) do
		if other.id ~= e.id and other.faction == e.faction then
			local dx = other.x - e.x
			local dy = other.y - e.y
			local min_dist = (e.size + other.size) * cfg.vessel_factor
			local d_sq = dx * dx + dy * dy
			if d_sq <= min_dist * min_dist then
				local dot = dx * cos_h + dy * sin_h
				if dot > 0 then
					local cross = cos_h * dy - sin_h * dx
					local strength = (1.0 - math.sqrt(d_sq) / min_dist) * cfg.vessel_strength
					if cross >= 0 then
						adjust = adjust - strength
					else
						adjust = adjust + strength
					end
				end
			end
		end
	end
	if adjust ~= 0.0 then
		return adjust
	end
	return nil
end

local function calc_land_avoidance(e)
	local cfg = config.avoidance
	local probe_dist = math.min(e.size * 10.0 + math.abs(e.speed) * 8.0, 1500.0)
	local land_score = 0.0
	local forward_blocked = false
	for _, offset in ipairs(LAND_PROBE_ANGLES) do
		local angle = e.heading + offset
		local px = e.x + math.cos(angle) * probe_dist
		local py = e.y + math.sin(angle) * probe_dist
		if is_land(px, py) then
			if math.abs(offset) < 0.1 then
				forward_blocked = true
			elseif offset > 0 then
				land_score = land_score + 1.0
			else
				land_score = land_score - 1.0
			end
		end
	end
	local rudder = nil
	if land_score > 0 then
		rudder = -cfg.land_strength
	elseif land_score < 0 then
		rudder = cfg.land_strength
	elseif forward_blocked then
		local left_clear = not is_land(
			e.x + math.cos(e.heading - math.pi / 3) * probe_dist,
			e.y + math.sin(e.heading - math.pi / 3) * probe_dist
		)
		if left_clear then
			rudder = -cfg.land_strength
		else
			rudder = cfg.land_strength
		end
	end
	if rudder then
		if forward_blocked then
			return rudder, 0.3
		end
		return rudder, 1.0
	end
	return nil
end

local function calc_exclusion_zone_steering(e)
	local buffer = config.avoidance.exclusion_buffer
	for _, zone in ipairs(gamedata.exclusion_zones) do
		if zone.behavior_set[e.behavior] then
			local strength
			if steering.point_in_polygon(e.x, e.y, zone.polygon) then
				strength = 1.0
			else
				local dist = steering.dist_to_polygon_edge(e.x, e.y, zone.polygon)
				if dist >= buffer then
					strength = nil
				else
					strength = 0.5 * (1.0 - dist / buffer)
				end
			end
			if strength then
				-- Tankers steer toward their current route waypoint, not the
				-- strait center, so zones near the southern coast don't pull
				-- them onto the wrong lane.
				local tx, ty = gamedata.strait_center[1], gamedata.strait_center[2]
				if e.behavior == "tanker_transit" then
					local route_cfg = gamedata.routes[e.bot.destination] or gamedata.routes.oman
					if e.bot.waypoint_index < #route_cfg.route then
						local wp = route_cfg.route[e.bot.waypoint_index + 1]
						tx, ty = wp[1], wp[2]
					else
						tx, ty = route_cfg.exit[1], route_cfg.exit[2]
					end
				end
				local rudder
				local wp = steering.find_lane_waypoint(e.x, e.y, tx, ty)
				if wp then
					rudder = steering.steer_toward(e, wp[1], wp[2])
				else
					rudder = steering.steer_toward(e, tx, ty)
				end
				return rudder, strength
			end
		end
	end
	return nil
end

local function apply_avoidance(e, ctx)
	local best_rudder = e.bot.rudder
	local best_throttle = e.bot.throttle

	local vessel_rudder = calc_vessel_avoidance(e, ctx)
	if vessel_rudder then
		best_rudder = steering.clamp01(e.bot.rudder + vessel_rudder)
	end

	local land_rudder, land_throttle_mult = calc_land_avoidance(e)
	if land_rudder then
		best_rudder = land_rudder
		best_throttle = best_throttle * land_throttle_mult
	end

	local zone_rudder, zone_strength = calc_exclusion_zone_steering(e)
	if zone_rudder then
		best_rudder = best_rudder * (1.0 - zone_strength) + zone_rudder * zone_strength
		best_throttle = math.max(e.bot.throttle, 0.5 * zone_strength)
	end

	e.bot.rudder = best_rudder
	e.bot.throttle = best_throttle
end

-- ---------------------------------------------------------------------------
-- Per-tick entry point
-- ---------------------------------------------------------------------------

local function compute_controls(world)
	current_time = world.time
	prune_scents()

	-- Collect per-tick context
	local ctx = {
		world = world,
		time = world.time,
		dt = world.dt,
		scents = scents,
		threats = build_threats(world),
		patrol_anchors = patrol_anchors,
		frigates = {},
		tankers = {},
		shaheds = {},
		quadcopters = {},
		speedboats = {},
		ships = {},
		by_id = {},
		drone_counts = {},
		escort_counts = {},
		speedboat_counts = {},
	}

	for _, e in ipairs(world.entities) do
		if e.hp > 0 then
			ctx.by_id[e.id] = e
			if e.type == "frigate" then
				ctx.frigates[#ctx.frigates + 1] = e
			elseif e.type == "oil_tanker" then
				ctx.tankers[#ctx.tankers + 1] = e
			end
			if not e.airborne then
				ctx.ships[#ctx.ships + 1] = e
			end
			if e.behavior then
				if e.type == "shahed" then
					ctx.shaheds[#ctx.shaheds + 1] = e
				elseif e.type == "quadcopter" then
					ctx.quadcopters[#ctx.quadcopters + 1] = e
				elseif e.type == "speedboat" then
					ctx.speedboats[#ctx.speedboats + 1] = e
				end
				-- Seed per-group target pressure counts from current assignments
				local target = e.bot.target
				if target ~= 0 then
					if e.behavior == "shahed_intercept" or e.behavior == "quadcopter_intercept" then
						ctx.drone_counts[target] = (ctx.drone_counts[target] or 0) + 1
					elseif e.behavior == "escort" then
						ctx.escort_counts[target] = (ctx.escort_counts[target] or 0) + 1
					elseif e.behavior == "swarm_attack" then
						ctx.speedboat_counts[target] = (ctx.speedboat_counts[target] or 0) + 1
					end
				end
			end
		end
	end

	local controls = {}
	local errors = {}

	for _, e in ipairs(world.entities) do
		if e.behavior and e.hp > 0 then
			local fn = behaviors[e.behavior]
			if fn then
				local ok, err = pcall(fn, e, ctx)
				if not ok then
					errors[#errors + 1] = "entity " .. e.id .. " (" .. e.behavior .. "): " .. tostring(err)
				end
			else
				errors[#errors + 1] = "entity " .. e.id .. ": unknown behavior " .. tostring(e.behavior)
			end
			if not e.airborne then
				local ok, err = pcall(apply_avoidance, e, ctx)
				if not ok then
					errors[#errors + 1] = "entity " .. e.id .. " (avoidance): " .. tostring(err)
				end
			end
			controls[#controls + 1] = {
				id = e.id,
				throttle = e.bot.throttle,
				rudder = e.bot.rudder,
				target = e.bot.target,
				waypoint_index = e.bot.waypoint_index,
				stamina = e.bot.stamina,
			}
		end
	end

	return controls, errors
end

-- ---------------------------------------------------------------------------
-- Config access for host dev panels: flat dotted paths <-> live config table
-- ---------------------------------------------------------------------------

local function get_config_flat()
	local flat = {}
	local function walk(prefix, t)
		for k, v in pairs(t) do
			local path = prefix == "" and k or (prefix .. "." .. k)
			if type(v) == "table" then
				walk(path, v)
			else
				flat[path] = v
			end
		end
	end
	walk("", config)
	return flat
end

local function set_config(path, value)
	local node = config
	local key = nil
	for part in string.gmatch(path, "[^%.]+") do
		if key then
			node = node[key]
			if type(node) ~= "table" then
				return false
			end
		end
		key = part
	end
	if key and type(node[key]) == "number" then
		node[key] = value
		return true
	end
	return false
end

return {
	compute_controls = compute_controls,
	add_scent = add_scent,
	get_config_flat = get_config_flat,
	set_config = set_config,
	waypoint_follow = steering.waypoint_follow,
}
