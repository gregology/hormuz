-- Tanker transit: follow lane waypoints, brake for tankers ahead, drift from danger.
-- Ported from server bot_ai.py _tanker_ai / run_tanker_ai.

local config = require("ai.config")
local steering = require("ai.lib.steering")

return function(e, ctx)
	local cfg = config.tanker
	local rudder, i = steering.waypoint_follow(
		e.x,
		e.y,
		e.heading,
		e.bot.waypoint_index,
		e.bot.destination
	)
	local throttle = 1.0
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
