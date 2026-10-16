-- Escort assignment: each frigate is committed to one convoy until that
-- convoy arrives or is sunk. Frigates no convoy needs stay spare: they patrol
-- the lane and answer attacks.
--
-- Commitment is the point. Re-picking the best tanker every tick sent
-- frigates back and forth through the strait without reaching anyone.

local config = require("ai.config")
local groups = require("ai.lib.groups")

local M = {}

local function distance_sq(e, convoy)
	return (e.x - convoy.x) ^ 2 + (e.y - convoy.y) ^ 2
end

function M.coordinate(ctx)
	local cfg = config.escort
	local frigates = ctx.bots.escort
	local convoys = groups.of_kind("convoy")

	local assigned = {}
	for _, convoy in ipairs(convoys) do
		assigned[convoy.id] = {}
	end
	for _, f in ipairs(frigates) do
		local convoy = groups.get(f.bot.group)
		if convoy and convoy.kind == "convoy" then
			table.insert(assigned[convoy.id], f)
		else
			f.bot.group = 0
		end
	end

	-- A convoy that lost ships may need fewer escorts: free the furthest.
	for _, convoy in ipairs(convoys) do
		local list = assigned[convoy.id]
		if #list > convoy.escorts_wanted then
			table.sort(list, function(a, b)
				local da, db = distance_sq(a, convoy), distance_sq(b, convoy)
				if da ~= db then
					return da < db
				end
				return a.id < b.id
			end)
			for i = #list, convoy.escorts_wanted + 1, -1 do
				list[i].bot.group = 0
				list[i] = nil
			end
		end
	end

	-- Fill vacancies nearest-first. Convoys at sea come before convoys still
	-- forming, which are waiting in the anchorage rather than exposed.
	while true do
		local best_cost, best_frigate, best_convoy = math.huge, nil, nil
		for _, convoy in ipairs(convoys) do
			if #assigned[convoy.id] < convoy.escorts_wanted then
				local weight = convoy.phase == "forming" and cfg.forming_cost or 1.0
				for _, f in ipairs(frigates) do
					if f.bot.group == 0 then
						local cost = distance_sq(f, convoy) * weight * weight
						if cost < best_cost then
							best_cost, best_frigate, best_convoy = cost, f, convoy
						end
					end
				end
			end
		end
		if not best_frigate then
			break
		end
		best_frigate.bot.group = best_convoy.id
		table.insert(assigned[best_convoy.id], best_frigate)
	end

	for _, convoy in ipairs(convoys) do
		local list = assigned[convoy.id]
		table.sort(list, function(a, b)
			return a.id < b.id
		end)
		convoy.escorts = groups.ids(list)
	end
end

return M
