-- Frigate: keep station on the convoy it is assigned to (coordination/
-- escorts.lua), breaking off to drive away surface threats near it. A spare
-- frigate (no convoy needs it) rushes to danger, keeps clear of other
-- frigates, and otherwise patrols the least-covered stretch of the lane.

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local groups = require("ai.lib.groups")
local steering = require("ai.lib.steering")

local function distance(ax, ay, bx, by)
	return math.sqrt((ax - bx) ^ 2 + (ay - by) ^ 2)
end

local function clear_water(x, y, from)
	return not is_land(x, y) and not is_land((x + from.x) * 0.5, (y + from.y) * 0.5)
end

--- Station for escort `slot` of `count`: abeam a ship spread along the
--- column, first on the side facing the nearest speedboat base, then
--- alternating. Falls back to the far side, then to the lane ahead.
local function station(ships, slot, count)
	local cfg = config.escort
	local anchor = ships[math.min(#ships, math.floor((slot - 0.5) * #ships / count) + 1)]
	local cos_h, sin_h = math.cos(anchor.heading), math.sin(anchor.heading)

	local home, home_sq = gamedata.speedboat_homes[1], math.huge
	for _, h in ipairs(gamedata.speedboat_homes) do
		local d_sq = (h[1] - anchor.x) ^ 2 + (h[2] - anchor.y) ^ 2
		if d_sq < home_sq then
			home, home_sq = h, d_sq
		end
	end
	-- Starboard is (-sin, cos) in this y-down frame.
	local side = (cos_h * (home[2] - anchor.y) - sin_h * (home[1] - anchor.x)) >= 0 and 1 or -1
	if slot % 2 == 0 then
		side = -side
	end

	for _, s in ipairs({ side, -side }) do
		local x = anchor.x - sin_h * s * cfg.station_offset
		local y = anchor.y + cos_h * s * cfg.station_offset
		if clear_water(x, y, anchor) then
			return x, y, anchor
		end
	end
	return anchor.x + cos_h * config.convoy.spacing, anchor.y + sin_h * config.convoy.spacing, anchor
end

--- Nearest surface threat close to the convoy. Drones are left to the
--- autocannon and jammer: they are too fast to chase.
local function threat_near(e, ships, ctx)
	local cfg = config.escort
	local best, best_d = nil, math.huge
	for _, t in ipairs(ctx.threats) do
		if not t.airborne then
			for _, ship in ipairs(ships) do
				if distance(t.x, t.y, ship.x, ship.y) < cfg.defend_range then
					local d = distance(t.x, t.y, e.x, e.y)
					if d < best_d then
						best, best_d = t, d
					end
					break
				end
			end
		end
	end
	return best
end

local function steer_via_lane(e, x, y)
	if distance(e.x, e.y, x, y) > config.nav.transit_dist then
		local wp = steering.find_lane_waypoint(e.x, e.y, x, y)
		if wp then
			return steering.steer_toward(e, wp[1], wp[2])
		end
	end
	return steering.steer_toward(e, x, y)
end

local function escort(e, convoy, ships, ctx)
	local cfg = config.escort
	local escorts = convoy.escorts or {}
	local slot = 1
	for i, id in ipairs(escorts) do
		if id == e.id then
			slot = i
		end
	end
	local x, y, anchor = station(ships, slot, math.max(#escorts, slot))
	e.bot.target = anchor.id

	local threat = threat_near(e, ships, ctx)
	local cx, cy = groups.centre(ships)
	if threat and distance(e.x, e.y, cx, cy) < cfg.leash then
		e.bot.rudder = steering.steer_toward(e, threat.x, threat.y)
		e.bot.throttle = 1.0
		return
	end

	if distance(e.x, e.y, x, y) > cfg.catch_up_range then
		e.bot.rudder = steering.clamp01(steer_via_lane(e, x, y))
		e.bot.throttle = 1.0
		return
	end

	-- Match the ship's velocity, plus a correction toward the station: the
	-- frigate closes quickly from any side and settles parallel to the convoy.
	local vx = math.cos(anchor.heading) * anchor.speed + (x - e.x) * cfg.station_gain
	local vy = math.sin(anchor.heading) * anchor.speed + (y - e.y) * cfg.station_gain
	e.bot.rudder = steering.steer_toward(e, e.x + vx, e.y + vy)
	local speed = math.sqrt(vx * vx + vy * vy)
	-- Rudders need propeller wash: never drop below steerage throttle.
	e.bot.throttle = math.max(cfg.steerage_throttle, steering.throttle_for_speed(speed, gamedata.max_speeds[e.type]))
end

local function spare(e, ctx)
	local cfg = config.escort
	e.bot.target = 0
	local rudder_sum = 0.0

	local danger = steering.nearest_danger(ctx, e.x, e.y, cfg.danger_range * cfg.danger_range)
	if danger then
		rudder_sum = rudder_sum + steering.steer_toward(e, e.x + danger[1], e.y + danger[2]) * cfg.weight_danger * danger[3]
	else
		local anchor = steering.pick_patrol_anchor(ctx, e)
		rudder_sum = steer_via_lane(e, anchor[1], anchor[2])
	end

	local repel_range_sq = cfg.repel_range * cfg.repel_range
	for _, f in ipairs(ctx.frigates) do
		if f.id ~= e.id then
			local dx = f.x - e.x
			local dy = f.y - e.y
			local d_sq = dx * dx + dy * dy
			if d_sq <= repel_range_sq and d_sq >= 1.0 then
				local repel_strength = (1.0 - math.sqrt(d_sq) / cfg.repel_range) * cfg.weight_repel
				rudder_sum = rudder_sum - steering.steer_toward(e, f.x, f.y) * repel_strength
			end
		end
	end

	e.bot.rudder = steering.clamp01(rudder_sum)
	e.bot.throttle = danger and 1.0 or cfg.idle_throttle
end

return function(e, ctx)
	local convoy = groups.get(e.bot.group)
	local ships = convoy and groups.alive_members(convoy, ctx) or {}
	if #ships > 0 then
		escort(e, convoy, ships, ctx)
	else
		spare(e, ctx)
	end
end
