-- Frigate escort: three local rules — escort least-contested tanker,
-- rush to danger, repel other frigates. Ported from bot_ai.py _escort_ai.

local config = require("ai.config")
local steering = require("ai.lib.steering")

return function(e, ctx)
	local cfg = config.escort
	local rudder_sum = 0.0

	-- Rule 1: pick a tanker using pressure scoring (least-contested, closest,
	-- endangered). Linear distance + cubic pressure so far unescorted tankers
	-- outscore crowded nearby ones.
	local tanker = steering.pick_target(ctx, e, {
		factions = { civilian = true },
		max_range_sq = math.huge,
		counts = ctx.escort_counts,
		pressure_power = cfg.pressure_power,
		linear_distance = true,
		threat_boost = true,
		coverage = ctx.frigates,
	})

	if tanker then
		local dx = tanker.x - e.x
		local dy = tanker.y - e.y
		local dist = math.sqrt(dx * dx + dy * dy)

		if dist > cfg.offset_dist then
			-- Navigate toward tanker — lane waypoints when far to avoid islands
			if dist > config.nav.transit_dist then
				local wp = steering.find_lane_waypoint(e.x, e.y, tanker.x, tanker.y)
				if wp then
					rudder_sum = rudder_sum + steering.steer_toward(e, wp[1], wp[2]) * cfg.weight_presence
				else
					rudder_sum = rudder_sum + steering.steer_toward(e, tanker.x, tanker.y) * cfg.weight_presence
				end
			else
				rudder_sum = rudder_sum + steering.steer_toward(e, tanker.x, tanker.y) * cfg.weight_presence
			end
		else
			-- At desired offset — match tanker's heading direction
			local ahead_x = e.x + math.cos(tanker.heading) * 500.0
			local ahead_y = e.y + math.sin(tanker.heading) * 500.0
			rudder_sum = rudder_sum + steering.steer_toward(e, ahead_x, ahead_y) * cfg.weight_presence * 0.5
		end
	end

	-- Rule 2: attract toward danger scent
	local danger = steering.nearest_danger(ctx, e.x, e.y, cfg.danger_range * cfg.danger_range)
	if danger then
		rudder_sum = rudder_sum + steering.steer_toward(e, e.x + danger[1], e.y + danger[2]) * cfg.weight_danger * danger[3]
	end

	-- Rule 3: repel from other frigates
	local repel_range_sq = cfg.repel_range * cfg.repel_range
	for _, f in ipairs(ctx.frigates) do
		if f.id ~= e.id then
			local dx = f.x - e.x
			local dy = f.y - e.y
			local d_sq = dx * dx + dy * dy
			if d_sq <= repel_range_sq and d_sq >= 1.0 then
				local dist = math.sqrt(d_sq)
				local repel_strength = (1.0 - dist / cfg.repel_range) * cfg.weight_repel
				rudder_sum = rudder_sum - steering.steer_toward(e, f.x, f.y) * repel_strength
			end
		end
	end

	-- No tanker or danger — patrol toward the least-covered lane anchor
	if not tanker and not danger then
		local anchor = steering.pick_patrol_anchor(ctx, e)
		local dx = anchor[1] - e.x
		local dy = anchor[2] - e.y
		local transit_sq = config.nav.transit_dist * config.nav.transit_dist
		if dx * dx + dy * dy > transit_sq then
			local wp = steering.find_lane_waypoint(e.x, e.y, anchor[1], anchor[2])
			if wp then
				rudder_sum = steering.steer_toward(e, wp[1], wp[2])
			else
				rudder_sum = steering.steer_toward(e, anchor[1], anchor[2])
			end
		else
			rudder_sum = steering.steer_toward(e, anchor[1], anchor[2])
		end
	end

	e.bot.rudder = steering.clamp01(rudder_sum)

	-- Throttle: fast when far from tanker, cruise when near
	if tanker then
		local dx = tanker.x - e.x
		local dy = tanker.y - e.y
		local dist = math.sqrt(dx * dx + dy * dy)
		if dist > cfg.offset_dist * 2 then
			e.bot.throttle = 1.0
		else
			e.bot.throttle = cfg.cruise_throttle
		end
	elseif danger then
		e.bot.throttle = 1.0
	else
		e.bot.throttle = cfg.idle_throttle
	end
end
