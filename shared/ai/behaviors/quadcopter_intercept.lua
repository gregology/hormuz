-- Quadcopter intercept: pressure-scored target selection (civilian + US),
-- swarm repulsion, loiter toward strait center when no target.
-- Ported from bot_ai.py _quadcopter_ai.

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local steering = require("ai.lib.steering")

return function(e, ctx)
	local target = steering.pick_target(ctx, e, {
		factions = { civilian = true, us = true },
		max_range_sq = config.quadcopter.visual_range * config.quadcopter.visual_range,
		counts = ctx.drone_counts,
	})

	local rudder
	if target then
		rudder = steering.steer_toward(e, target.x, target.y)
	else
		rudder = steering.steer_toward(e, gamedata.strait_center[1], gamedata.strait_center[2])
	end

	rudder = rudder + steering.repulsion(e, ctx.quadcopters, config.quadcopter.repel_range)

	e.bot.rudder = steering.clamp01(rudder)
	e.bot.throttle = 1.0
end
