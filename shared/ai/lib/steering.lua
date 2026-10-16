-- Steering primitives and target-selection scoring shared by all behaviors.
-- Ported from server bot_ai.py — keep behavior identical; constants live in config.lua.

local config = require("ai.config")
local gamedata = require("ai.gamedata")

local M = {}

local TWO_PI = math.pi * 2

-- Runtime compat: Lua 5.1/LuaJIT (lupa) has math.atan2; Lua 5.3+ (fengari)
-- folds it into math.atan(y, x).
local atan2 = math.atan2 or function(y, x)
	return math.atan(y, x)
end
M.atan2 = atan2

function M.clamp01(v)
	if v > 1.0 then
		return 1.0
	elseif v < -1.0 then
		return -1.0
	end
	return v
end

--- Return rudder value (-1 to 1) to steer entity e toward a target point.
function M.steer_toward(e, tx, ty)
	local desired = atan2(ty - e.y, tx - e.x)
	local diff = (desired - e.heading + math.pi) % TWO_PI - math.pi
	return M.clamp01(diff * 2.0)
end

--- Rudder to turn entity e directly away from a point. Negating
--- steer_toward is not the same: it gives no turn at all when the point is
--- dead ahead.
function M.steer_away(e, x, y)
	return M.steer_toward(e, 2.0 * e.x - x, 2.0 * e.y - y)
end

--- Rudder and throttle to stay near (x, y). A ship at rest still moves
--- (slope forces, collisions), so drift while inside the hold radius and
--- motor gently back once outside it.
function M.hold_at(e, x, y)
	local cfg = config.nav
	if (x - e.x) ^ 2 + (y - e.y) ^ 2 < cfg.hold_radius ^ 2 then
		return 0.0, 0.0
	end
	return M.steer_toward(e, x, y), cfg.hold_throttle
end

--- Throttle that settles a ship at `speed`: thrust is throttle x engine
--- power against drag that grows with speed squared, so top speed scales
--- with the square root of throttle.
function M.throttle_for_speed(speed, max_speed)
	local fraction = math.max(0.0, math.min(1.0, speed / max_speed))
	return fraction * fraction
end

--- Return nearest shipping lane waypoint that makes progress toward the target.
function M.find_lane_waypoint(x, y, tx, ty)
	local lane
	if tx < x then
		lane = gamedata.lanes.inbound
	else
		lane = gamedata.lanes.outbound
	end
	local to_target_sq = (tx - x) ^ 2 + (ty - y) ^ 2
	local best_wp = nil
	local best_dist_sq = math.huge
	for _, wp in ipairs(lane) do
		local wp_to_target_sq = (tx - wp[1]) ^ 2 + (ty - wp[2]) ^ 2
		if wp_to_target_sq < to_target_sq then
			local wp_to_us_sq = (wp[1] - x) ^ 2 + (wp[2] - y) ^ 2
			if wp_to_us_sq < best_dist_sq then
				best_dist_sq = wp_to_us_sq
				best_wp = wp
			end
		end
	end
	return best_wp
end

--- Ray-casting point-in-polygon test. polygon = {{x, y}, ...}
function M.point_in_polygon(x, y, polygon)
	local n = #polygon
	local inside = false
	local j = n
	for i = 1, n do
		local xi, yi = polygon[i][1], polygon[i][2]
		local xj, yj = polygon[j][1], polygon[j][2]
		if (yi > y) ~= (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi then
			inside = not inside
		end
		j = i
	end
	return inside
end

--- Minimum distance from point to the nearest edge of the polygon.
function M.dist_to_polygon_edge(x, y, polygon)
	local best = math.huge
	local n = #polygon
	for i = 1, n do
		local ax, ay = polygon[i][1], polygon[i][2]
		local bx, by = polygon[(i % n) + 1][1], polygon[(i % n) + 1][2]
		local dx, dy = bx - ax, by - ay
		local len_sq = dx * dx + dy * dy
		local d
		if len_sq == 0 then
			d = math.sqrt((x - ax) ^ 2 + (y - ay) ^ 2)
		else
			local t = math.max(0.0, math.min(1.0, ((x - ax) * dx + (y - ay) * dy) / len_sq))
			d = math.sqrt((x - (ax + t * dx)) ^ 2 + (y - (ay + t * dy)) ^ 2)
		end
		if d < best then
			best = d
		end
	end
	return best
end

--- Nearest active danger scent within max_range_sq.
--- ctx.scents holds {x, y, t} entries; strength decays linearly with age.
--- Returns {dx, dy, strength} or nil.
function M.nearest_danger(ctx, x, y, max_range_sq)
	local best_dist_sq = max_range_sq
	local best = nil
	for _, s in ipairs(ctx.scents) do
		local dx = s.x - x
		local dy = s.y - y
		local d_sq = dx * dx + dy * dy
		if d_sq < best_dist_sq then
			local strength = 1.0 - (ctx.time - s.t) / config.danger.duration
			if strength > 0 then
				best_dist_sq = d_sq
				best = { dx, dy, strength }
			end
		end
	end
	return best
end

--- Rudder adjustment from repulsion by nearby same-type swarm members.
--- swarm = array of entities; weight from config.drones.repel_weight.
function M.repulsion(e, swarm, range)
	local range_sq = range * range
	local adjust = 0.0
	for _, other in ipairs(swarm) do
		if other.id ~= e.id then
			local dx = other.x - e.x
			local dy = other.y - e.y
			local d_sq = dx * dx + dy * dy
			if d_sq <= range_sq and d_sq >= 1.0 then
				local dist = math.sqrt(d_sq)
				local strength = (1.0 - dist / range) * config.drones.repel_weight
				adjust = adjust - M.steer_toward(e, other.x, other.y) * strength
			end
		end
	end
	return adjust
end

--- Score all valid targets by distance and pressure, pick the best.
--- Re-evaluates every tick; current target gets a stickiness bonus.
--- Updates opts.counts in-place so later bots this tick see accurate pressure.
---
--- opts = {
---   factions = { civilian = true, ... },  -- target faction filter
---   max_range_sq = number,
---   counts = table,                       -- per-group pressure counts (entity_id -> n)
--- }
--- Returns the chosen target entity or nil.
function M.pick_target(ctx, e, opts)
	local old_target = e.bot.target
	local best_score = -1.0
	local best_id = 0
	local best_target = nil

	for _, t in ipairs(ctx.world.entities) do
		if t.hp > 0 and opts.factions[t.faction] then
			local dx = t.x - e.x
			local dy = t.y - e.y
			local d_sq = dx * dx + dy * dy
			if d_sq <= opts.max_range_sq then
				d_sq = math.max(d_sq, 1.0)
				local pressure = opts.counts[t.id] or 0
				-- Our own claim on the current target isn't crowding: counting it
				-- made the current target look busier than every alternative.
				if t.id == old_target then
					pressure = math.max(pressure - 1, 0)
				end
				local score = 1.0 / (d_sq * (1 + pressure))
				if t.id == e.bot.target then
					score = score * (1.0 + config.drones.target_stickiness)
				end
				if score > best_score then
					best_score = score
					best_id = t.id
					best_target = t
				end
			end
		end
	end

	if old_target ~= best_id then
		if old_target ~= 0 then
			opts.counts[old_target] = (opts.counts[old_target] or 1) - 1
		end
		if best_id ~= 0 then
			opts.counts[best_id] = (opts.counts[best_id] or 0) + 1
		end
	end

	e.bot.target = best_id
	return best_target
end

--- Pick the patrol anchor (lane endpoint/midpoint) with fewest nearby frigates.
function M.pick_patrol_anchor(ctx, e)
	local anchors = ctx.patrol_anchors
	local best_anchor = anchors[1]
	local best_pressure = math.huge
	for ai, anchor in ipairs(anchors) do
		local count = 0
		for _, f in ipairs(ctx.frigates) do
			if f.id ~= e.id then
				local fd_sq = (f.x - anchor[1]) ^ 2 + (f.y - anchor[2]) ^ 2
				local closer_to_other = false
				for oi, other in ipairs(anchors) do
					if oi ~= ai then
						local od_sq = (f.x - other[1]) ^ 2 + (f.y - other[2]) ^ 2
						if od_sq < fd_sq then
							closer_to_other = true
							break
						end
					end
				end
				if not closer_to_other then
					count = count + 1
				end
			end
		end
		-- Small distance bias so equal-pressure anchors prefer the nearer one
		local d_sq = (e.x - anchor[1]) ^ 2 + (e.y - anchor[2]) ^ 2
		local pressure = count + d_sq * 1e-12
		if pressure < best_pressure then
			best_pressure = pressure
			best_anchor = anchor
		end
	end
	return best_anchor
end

--- Waypoint route following shared by tanker transit AI and the player
--- tanker autopilot. waypoint_index is 0-based in host state.
--- Returns (rudder, new_waypoint_index).
function M.waypoint_follow(x, y, heading, waypoint_index, destination)
	local route_cfg = gamedata.routes[destination] or gamedata.routes.oman
	local route = route_cfg.route
	local i = waypoint_index
	local advance_sq = config.nav.waypoint_advance_dist ^ 2
	if i < #route then
		local wp = route[i + 1]
		local dx = wp[1] - x
		local dy = wp[2] - y
		if dx * dx + dy * dy < advance_sq then
			i = i + 1
		end
	end
	local probe = { x = x, y = y, heading = heading }
	local rudder
	if i < #route then
		rudder = M.steer_toward(probe, route[i + 1][1], route[i + 1][2])
	else
		rudder = M.steer_toward(probe, route_cfg.exit[1], route_cfg.exit[2])
	end
	return rudder, i
end

return M
