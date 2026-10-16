-- Tanker: wait at the start of the route while the convoy forms, then sail
-- the lane in column (keep station behind the ship ahead, and wait for the
-- ship behind), braking for tankers ahead and drifting away from danger.

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local groups = require("ai.lib.groups")
local steering = require("ai.lib.steering")

local function gap(a, b)
	return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2)
end

--- Speed that keeps the column together, from the ships either side.
local function column_speed(e, ctx)
	local cfg = config.convoy
	local top = gamedata.max_speeds[e.type]
	local cruise = top * cfg.cruise_speed
	local convoy = groups.get(e.bot.group)
	if not convoy then
		return cruise
	end
	local ships = groups.alive_members(convoy, ctx)
	local index = 0
	for i, ship in ipairs(ships) do
		if ship.id == e.id then
			index = i
		end
	end
	local speed = cruise
	local ahead = ships[index - 1]
	if ahead then
		speed = ahead.speed + (gap(e, ahead) - cfg.spacing) * cfg.gap_gain
	end
	local behind = ships[index + 1]
	if behind then
		-- A ship further back than this has fallen out (aground, crippled);
		-- it follows at full speed, and the column doesn't wait for it.
		local lag = gap(e, behind)
		if lag < cfg.straggler_range then
			local slack = math.max(0.0, lag - cfg.spacing * cfg.slack)
			speed = math.min(speed, cruise - slack * cfg.gap_gain)
		end
	end
	return math.max(0.0, math.min(speed, top))
end

return function(e, ctx)
	local cfg = config.tanker
	local convoy = groups.get(e.bot.group)
	local waiting = convoy and convoy.phase == "forming" or (not convoy and e.bot.waypoint_index == 0)
	if waiting then
		local anchor = convoy and convoy.anchors and convoy.anchors[e.id]
		if anchor then
			e.bot.rudder, e.bot.throttle = steering.hold_at(e, anchor[1], anchor[2])
		else
			e.bot.rudder, e.bot.throttle = 0.0, 0.0
		end
		return
	end

	local rudder, i = steering.waypoint_follow(e.x, e.y, e.heading, e.bot.waypoint_index, e.bot.destination)
	local throttle = steering.throttle_for_speed(column_speed(e, ctx), gamedata.max_speeds[e.type])
	local cos_h = math.cos(e.heading)
	local sin_h = math.sin(e.heading)

	-- Brake for tankers ahead (dot product with heading), proportional to distance
	local brake_range_sq = cfg.brake_range * cfg.brake_range
	for _, t in ipairs(ctx.tankers) do
		if t.id ~= e.id then
			local dx = t.x - e.x
			local dy = t.y - e.y
			local d_sq = dx * dx + dy * dy
			if d_sq <= brake_range_sq then
				local dot = dx * cos_h + dy * sin_h
				if dot > 0 then
					local tfrac = math.sqrt(d_sq) / cfg.brake_range
					local brake = cfg.brake_min_throttle + tfrac * (1.0 - cfg.brake_min_throttle)
					if brake < throttle then
						throttle = brake
					end
				end
			end
		end
	end

	-- Drift away from danger scent
	local danger = steering.nearest_danger(ctx, e.x, e.y, cfg.danger_range * cfg.danger_range)
	if danger then
		local cross = cos_h * danger[2] - sin_h * danger[1]
		if cross >= 0 then
			rudder = rudder - cfg.danger_rudder * danger[3]
		else
			rudder = rudder + cfg.danger_rudder * danger[3]
		end
		rudder = steering.clamp01(rudder)
	end

	e.bot.throttle = throttle
	e.bot.rudder = rudder
	e.bot.waypoint_index = i
end
