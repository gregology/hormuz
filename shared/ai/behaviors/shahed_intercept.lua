-- Shahed intercept: pressure-scored target selection, jammed near frigates,
-- swarm repulsion. Ported from bot_ai.py _shahed_ai.

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local steering = require("ai.lib.steering")

return function(e, ctx)
	-- Jammed by a nearby frigate: fly blind, straight ahead
	local jam_radius_sq = gamedata.jam_radius * gamedata.jam_radius
	for _, f in ipairs(ctx.frigates) do
		local dx = f.x - e.x
		local dy = f.y - e.y
		if dx * dx + dy * dy < jam_radius_sq then
			e.bot.rudder = 0.0
			e.bot.throttle = 1.0
			return
		end
	end

	local target = steering.pick_target(ctx, e, {
		factions = { civilian = true },
		max_range_sq = math.huge,
		counts = ctx.drone_counts,
	})

	local rudder = 0.0
	if target then
		rudder = steering.steer_toward(e, target.x, target.y)
	end

	rudder = rudder + steering.repulsion(e, ctx.shaheds, config.shahed.repel_range)

	e.bot.rudder = steering.clamp01(rudder)
	e.bot.throttle = 1.0
end
