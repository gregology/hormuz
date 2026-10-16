-- Speedboat: carry out its pack's plan (coordination/packs.lua). Muster at a
-- home, close in on the prey from this boat's own side of the pack, then run
-- alongside it with the bow gun. Without a pack, or once the pack withdraws,
-- go home and wait there, recharging stamina. Evading a frigate inside its
-- gun range overrides everything.

local config = require("ai.config")
local groups = require("ai.lib.groups")
local packs = require("ai.coordination.packs")
local steering = require("ai.lib.steering")

local function distance_sq(ax, ay, bx, by)
	return (ax - bx) ^ 2 + (ay - by) ^ 2
end

local function update_stamina(e, ctx, home_sq)
	local cfg = config.speedboat
	if home_sq < cfg.home_radius ^ 2 then
		e.bot.stamina = math.min(1.0, e.bot.stamina + cfg.stamina_recharge * ctx.dt)
		return
	end
	local drain = cfg.stamina_drain
	local target = ctx.by_id[e.bot.target]
	if target and distance_sq(target.x, target.y, e.x, e.y) < cfg.attack_range ^ 2 then
		drain = cfg.stamina_drain_attack
	end
	e.bot.stamina = math.max(0.0, e.bot.stamina - drain * ctx.dt)
end

local function nearest_frigate(e, ctx)
	local best, best_sq = nil, math.huge
	for _, f in ipairs(ctx.frigates) do
		local d_sq = distance_sq(f.x, f.y, e.x, e.y)
		if d_sq < best_sq then
			best, best_sq = f, d_sq
		end
	end
	return best, best_sq
end

--- Approach from this boat's own bearing around the prey, so a pack arrives
--- from several sides at once; inside strike range, run straight in.
local function hunt(e, ctx, pack, prey)
	local cfg = config.speedboat
	local pack_cfg = config.pack
	local d_sq = distance_sq(prey.x, prey.y, e.x, e.y)
	if d_sq <= cfg.attack_range ^ 2 then
		-- Run alongside, aiming ahead of the bow to keep it in the gun arc.
		local ahead_x = prey.x + math.cos(prey.heading) * 200.0
		local ahead_y = prey.y + math.sin(prey.heading) * 200.0
		return steering.steer_toward(e, ahead_x, ahead_y), 0.5 + 0.5 * (math.sqrt(d_sq) / cfg.attack_range)
	end
	if d_sq <= pack_cfg.strike_range ^ 2 then
		return steering.steer_toward(e, prey.x, prey.y), 1.0
	end

	local boats = groups.alive_members(pack, ctx)
	if #boats == 0 then
		boats = { e }
	end
	local index, count = 1, #boats
	for i, b in ipairs(boats) do
		if b.id == e.id then
			index = i
		end
	end
	local cx, cy = groups.centre(boats)
	local bearing = steering.atan2(cy - prey.y, cx - prey.x)
	local angle = bearing + (index - (count + 1) / 2) * pack_cfg.spread_angle
	local x = prey.x + math.cos(angle) * pack_cfg.approach_radius
	local y = prey.y + math.sin(angle) * pack_cfg.approach_radius
	if is_land(x, y) then
		x, y = prey.x, prey.y
	end
	return steering.steer_toward(e, x, y), 1.0
end

return function(e, ctx)
	local cfg = config.speedboat
	local home, home_sq = packs.nearest_home(e)
	update_stamina(e, ctx, home_sq)

	local frigate, frigate_sq = nearest_frigate(e, ctx)
	if frigate and frigate_sq < cfg.evasion_range ^ 2 then
		e.bot.rudder = steering.steer_away(e, frigate.x, frigate.y)
		e.bot.throttle = 1.0
		return
	end

	local pack = groups.get(e.bot.group)
	local prey = pack and ctx.by_id[pack.target]
	local rudder, throttle
	if pack and pack.phase == "gathering" then
		local mx, my = pack.muster[1], pack.muster[2]
		if distance_sq(mx, my, e.x, e.y) < config.pack.gather_radius ^ 2 then
			rudder, throttle = steering.hold_at(e, mx, my)
		else
			rudder, throttle = steering.steer_toward(e, mx, my), 1.0
		end
	elseif pack and pack.phase == "hunting" and prey then
		rudder, throttle = hunt(e, ctx, pack, prey)
	elseif home_sq < cfg.home_radius ^ 2 then
		rudder, throttle = steering.hold_at(e, home[1], home[2])
	else
		rudder, throttle = steering.steer_toward(e, home[1], home[2]), 1.0
	end

	if throttle > 0 then
		rudder = rudder + steering.repulsion(e, ctx.speedboats, cfg.repel_range)
	end
	e.bot.rudder = steering.clamp01(rudder)
	e.bot.throttle = throttle
end
