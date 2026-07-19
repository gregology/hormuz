-- Speedboat wolf pack: stamina-based hit-and-run cycles.
-- Stamina drains while hunting, recharges near spawn; frigate evasion
-- overrides everything. Ported from bot_ai.py _speedboat_ai.

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local steering = require("ai.lib.steering")

return function(e, ctx)
	local cfg = config.speedboat

	-- Stamina: recharge near home, drain while out (faster in attack range)
	local near_home = false
	local home_radius_sq = cfg.home_radius * cfg.home_radius
	for _, home in ipairs(gamedata.speedboat_homes) do
		local dx = home[1] - e.x
		local dy = home[2] - e.y
		if dx * dx + dy * dy < home_radius_sq then
			near_home = true
			break
		end
	end

	if near_home then
		e.bot.stamina = math.min(1.0, e.bot.stamina + cfg.stamina_recharge * ctx.dt)
	else
		local drain = cfg.stamina_drain
		if e.bot.target ~= 0 then
			local target = ctx.by_id[e.bot.target]
			if target then
				local dx = target.x - e.x
				local dy = target.y - e.y
				if dx * dx + dy * dy < cfg.attack_range * cfg.attack_range then
					drain = cfg.stamina_drain_attack
				end
			end
		end
		e.bot.stamina = math.max(0.0, e.bot.stamina - drain * ctx.dt)
	end

	-- Frigate evasion: highest priority, always active
	local nearest_frigate = nil
	local nearest_frigate_sq = math.huge
	for _, f in ipairs(ctx.frigates) do
		local dx = f.x - e.x
		local dy = f.y - e.y
		local d_sq = dx * dx + dy * dy
		if d_sq < nearest_frigate_sq then
			nearest_frigate_sq = d_sq
			nearest_frigate = f
		end
	end

	local function release_target()
		if e.bot.target ~= 0 then
			ctx.speedboat_counts[e.bot.target] = math.max(0, (ctx.speedboat_counts[e.bot.target] or 1) - 1)
			e.bot.target = 0
		end
	end

	if nearest_frigate and nearest_frigate_sq < cfg.evasion_range * cfg.evasion_range then
		local dist = math.sqrt(nearest_frigate_sq)
		local proximity = 1.0 - dist / cfg.evasion_range
		local evasion_rudder = -steering.steer_toward(e, nearest_frigate.x, nearest_frigate.y)
		local evasion_strength = math.min(1.0, proximity * cfg.evasion_weight)
		e.bot.rudder = steering.clamp01(evasion_rudder * evasion_strength)
		e.bot.throttle = 1.0
		release_target()
		return
	end

	-- Retreat: stamina depleted, head to nearest spawn
	if e.bot.stamina <= cfg.stamina_threshold and not near_home then
		local best_home = gamedata.speedboat_homes[1]
		local best_dist_sq = math.huge
		for _, home in ipairs(gamedata.speedboat_homes) do
			local dx = home[1] - e.x
			local dy = home[2] - e.y
			local d_sq = dx * dx + dy * dy
			if d_sq < best_dist_sq then
				best_dist_sq = d_sq
				best_home = home
			end
		end
		e.bot.rudder = steering.steer_toward(e, best_home[1], best_home[2])
		e.bot.throttle = 1.0
		release_target()
		return
	end

	-- Hunt: attack tankers, avoiding escorted ones
	local target = steering.pick_target(ctx, e, {
		factions = { civilian = true },
		max_range_sq = cfg.visual_range * cfg.visual_range,
		counts = ctx.speedboat_counts,
		frigate_penalty = ctx.frigates,
	})

	local rudder = 0.0
	local throttle = 1.0

	if target then
		local dx = target.x - e.x
		local dy = target.y - e.y
		local dist = math.sqrt(dx * dx + dy * dy)
		if dist > cfg.attack_range then
			rudder = steering.steer_toward(e, target.x, target.y)
		else
			local ahead_x = target.x + math.cos(target.heading) * 200.0
			local ahead_y = target.y + math.sin(target.heading) * 200.0
			rudder = steering.steer_toward(e, ahead_x, ahead_y)
			throttle = 0.5 + 0.5 * (dist / cfg.attack_range)
		end
	else
		rudder = steering.steer_toward(e, gamedata.strait_center[1], gamedata.strait_center[2])
		throttle = 0.7
	end

	-- Danger attraction: rush toward active attacks (only while hunting)
	local danger = steering.nearest_danger(ctx, e.x, e.y, cfg.danger_range * cfg.danger_range)
	if danger then
		rudder = rudder
			+ steering.steer_toward(e, e.x + danger[1], e.y + danger[2]) * cfg.weight_danger * danger[3]
	end

	-- Pack repulsion
	rudder = rudder + steering.repulsion(e, ctx.speedboats, cfg.repel_range)

	e.bot.rudder = steering.clamp01(rudder)
	e.bot.throttle = throttle
end
