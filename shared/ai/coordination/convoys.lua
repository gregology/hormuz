-- Convoys: tankers gather where their route starts, wait for enough ships and
-- an escort on station, then sail the route together as a column.
--
-- A tanker that is already under way without a convoy (a player handed it
-- back, its convoy was sunk around it) joins a convoy sailing nearby or sails
-- on as a convoy of one, so escorts can still be assigned to it.

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local groups = require("ai.lib.groups")

local M = {}

local function next_waypoint(e)
	local route_cfg = gamedata.routes[e.bot.destination] or gamedata.routes.oman
	return route_cfg.route[e.bot.waypoint_index + 1] or route_cfg.exit
end

--- Lead ship first: furthest along the route, then nearest its next waypoint.
local function order_column(ships)
	local remaining = {}
	for _, e in ipairs(ships) do
		local wp = next_waypoint(e)
		remaining[e.id] = (wp[1] - e.x) ^ 2 + (wp[2] - e.y) ^ 2
	end
	table.sort(ships, function(a, b)
		if a.bot.waypoint_index ~= b.bot.waypoint_index then
			return a.bot.waypoint_index > b.bot.waypoint_index
		end
		if remaining[a.id] ~= remaining[b.id] then
			return remaining[a.id] < remaining[b.id]
		end
		return a.id < b.id
	end)
end

local function at_route_start(e)
	return e.bot.waypoint_index == 0
end

local function restore(e, ctx)
	local anchored = at_route_start(e) and math.abs(e.speed) < config.convoy.anchored_speed
	return groups.restore(e.bot.group, "convoy", {
		destination = e.bot.destination,
		phase = anchored and "forming" or "sailing",
		formed_at = ctx.time,
	})
end

local function forming_convoy(destination)
	for _, convoy in ipairs(groups.of_kind("convoy")) do
		if
			convoy.phase == "forming"
			and convoy.destination == destination
			and #convoy.members < config.convoy.max_size
		then
			return convoy
		end
	end
	return nil
end

local function sailing_convoy_near(e, ctx)
	local best, best_sq = nil, config.convoy.join_range ^ 2
	for _, convoy in ipairs(groups.of_kind("convoy")) do
		if
			convoy.phase == "sailing"
			and convoy.destination == e.bot.destination
			and #convoy.members < config.convoy.max_size
		then
			for _, id in ipairs(convoy.members) do
				local ship = ctx.by_id[id]
				if ship then
					local d_sq = (ship.x - e.x) ^ 2 + (ship.y - e.y) ^ 2
					if d_sq < best_sq then
						best, best_sq = convoy, d_sq
					end
				end
			end
		end
	end
	return best
end

local function escorts_on_station(convoy, ctx)
	local range_sq = config.convoy.escort_ready_range ^ 2
	local count = 0
	for _, f in ipairs(ctx.bots.escort) do
		if f.bot.group == convoy.id and (f.x - convoy.x) ^ 2 + (f.y - convoy.y) ^ 2 < range_sq then
			count = count + 1
		end
	end
	return count
end

local function maybe_sail(convoy, ctx)
	local cfg = config.convoy
	local enough_ships = #convoy.members >= cfg.min_size or ctx.time - convoy.formed_at >= cfg.muster_timeout
	if not enough_ships then
		convoy.ready_at = nil
		return
	end
	convoy.ready_at = convoy.ready_at or ctx.time
	-- Without the timeout, losing every frigate (sunk, or all taken by
	-- players) would stop all traffic until one came back.
	if escorts_on_station(convoy, ctx) >= cfg.escorts_to_sail or ctx.time - convoy.ready_at >= cfg.escort_timeout then
		convoy.phase = "sailing"
	end
end

function M.coordinate(ctx)
	local tankers = ctx.bots.tanker_transit

	local members = {}
	for _, t in ipairs(tankers) do
		local convoy = groups.get(t.bot.group)
		if t.bot.group ~= 0 and not convoy then
			convoy = restore(t, ctx)
		end
		if convoy and convoy.kind == "convoy" and convoy.destination == t.bot.destination then
			members[convoy.id] = members[convoy.id] or {}
			table.insert(members[convoy.id], t.id)
		else
			-- Arrived (the host turned it round for the return leg) or never assigned.
			t.bot.group = 0
		end
	end
	for _, convoy in ipairs(groups.of_kind("convoy")) do
		convoy.members = members[convoy.id] or {}
		if #convoy.members == 0 then
			groups.remove(convoy.id)
		end
	end

	for _, t in ipairs(tankers) do
		if t.bot.group == 0 then
			local convoy
			if at_route_start(t) then
				convoy = forming_convoy(t.bot.destination)
					or groups.create("convoy", { destination = t.bot.destination, phase = "forming", formed_at = ctx.time })
			else
				convoy = sailing_convoy_near(t, ctx)
					or groups.create("convoy", { destination = t.bot.destination, phase = "sailing", formed_at = ctx.time })
			end
			table.insert(convoy.members, t.id)
			t.bot.group = convoy.id
		end
	end

	for _, convoy in ipairs(groups.of_kind("convoy")) do
		local ships = groups.alive_members(convoy, ctx)
		order_column(ships)
		convoy.members = groups.ids(ships)
		convoy.x, convoy.y = groups.centre(ships)
		convoy.escorts_wanted =
			math.min(math.ceil(#ships / config.escort.ships_per_escort), config.escort.max_per_convoy)
		if convoy.phase == "forming" then
			-- Each ship holds where it joined (or where it was when the record
			-- was restored).
			convoy.anchors = convoy.anchors or {}
			for _, ship in ipairs(ships) do
				convoy.anchors[ship.id] = convoy.anchors[ship.id] or { ship.x, ship.y }
			end
			maybe_sail(convoy, ctx)
		end
	end
end

return M
