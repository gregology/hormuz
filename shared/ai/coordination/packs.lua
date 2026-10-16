-- Speedboat packs: rested boats muster at a home, pick the easiest tanker in
-- reach (furthest from any frigate, nearest home), close in together from
-- different sides, and withdraw together when a frigate comes or their
-- stamina runs low. Boats rest at home until fully recharged before joining
-- the next pack.

local config = require("ai.config")
local gamedata = require("ai.gamedata")
local groups = require("ai.lib.groups")

local M = {}

-- Time each free boat became rested; lone boats hunt alone after a while.
local rested_since = {}

local function distance_sq(ax, ay, bx, by)
	return (ax - bx) ^ 2 + (ay - by) ^ 2
end

local function nearest_home(e)
	local best, best_sq = gamedata.speedboat_homes[1], math.huge
	for _, home in ipairs(gamedata.speedboat_homes) do
		local d_sq = distance_sq(home[1], home[2], e.x, e.y)
		if d_sq < best_sq then
			best, best_sq = home, d_sq
		end
	end
	return best, best_sq
end
M.nearest_home = nearest_home

local function nearest_frigate_sq(ctx, x, y)
	local best = math.huge
	for _, f in ipairs(ctx.frigates) do
		best = math.min(best, distance_sq(f.x, f.y, x, y))
	end
	return best
end

--- The easiest tanker within reach of (x, y), or nil. Tankers with a frigate
--- inside guarded_range are not considered at all.
local function easiest_prey(ctx, x, y)
	local cfg = config.pack
	local best, best_score = nil, 0.0
	for _, t in ipairs(ctx.tankers) do
		if t.faction == "civilian" then
			local reach_sq = distance_sq(t.x, t.y, x, y)
			local escort_sq = nearest_frigate_sq(ctx, t.x, t.y)
			if reach_sq <= cfg.hunt_range ^ 2 and escort_sq >= cfg.guarded_range ^ 2 then
				-- Frigate-free time bought per unit of travel.
				local exposure = math.min(math.sqrt(escort_sq), cfg.hunt_range)
				local score = exposure / math.max(math.sqrt(reach_sq), 1000.0)
				if score > best_score then
					best, best_score = t, score
				end
			end
		end
	end
	return best
end

local function at_home(e)
	local _, d_sq = nearest_home(e)
	return d_sq < config.speedboat.home_radius ^ 2
end

local function restore(e, ctx)
	local home = nearest_home(e)
	return groups.restore(e.bot.group, "pack", {
		phase = e.bot.target ~= 0 and "hunting" or "withdrawing",
		target = e.bot.target,
		muster = { home[1], home[2] },
		formed_at = ctx.time,
	})
end

local function disband(pack, boats)
	for _, b in ipairs(boats) do
		b.bot.group = 0
		b.bot.target = 0
	end
	groups.remove(pack.id)
end

local function withdraw(pack)
	pack.phase = "withdrawing"
	pack.target = 0
end

local function mean_stamina(boats)
	local total = 0.0
	for _, b in ipairs(boats) do
		total = total + b.bot.stamina
	end
	return total / #boats
end

local function update(pack, boats, ctx)
	local cfg = config.pack
	local x, y = groups.centre(boats)
	if pack.phase == "gathering" or pack.phase == "hunting" then
		local prey = ctx.by_id[pack.target]
		local break_off_sq = cfg.break_off_range ^ 2
		if
			not prey
			or prey.type ~= "oil_tanker"
			or nearest_frigate_sq(ctx, prey.x, prey.y) < break_off_sq
		then
			local from_x, from_y = x, y
			if pack.phase == "gathering" then
				from_x, from_y = pack.muster[1], pack.muster[2]
			end
			prey = easiest_prey(ctx, from_x, from_y)
			pack.target = prey and prey.id or 0
		end
		if not prey then
			if pack.phase == "gathering" then
				return disband(pack, boats)
			end
			withdraw(pack)
		elseif nearest_frigate_sq(ctx, x, y) < break_off_sq or mean_stamina(boats) < cfg.withdraw_stamina then
			withdraw(pack)
		end
	end

	if pack.phase == "gathering" then
		local gathered = true
		for _, b in ipairs(boats) do
			if distance_sq(b.x, b.y, pack.muster[1], pack.muster[2]) > cfg.gather_radius ^ 2 then
				gathered = false
			end
		end
		if gathered or ctx.time - pack.formed_at >= cfg.gather_timeout then
			pack.phase = "hunting"
		end
	end

	local remaining = {}
	for _, b in ipairs(boats) do
		if pack.phase == "withdrawing" and at_home(b) then
			b.bot.group = 0
			b.bot.target = 0
		else
			b.bot.target = pack.target
			remaining[#remaining + 1] = b
		end
	end
	pack.members = groups.ids(remaining)
	if #remaining == 0 then
		groups.remove(pack.id)
	end
end

local function form_packs(ctx, boats)
	local cfg = config.pack
	local rested = {}
	local since = {}
	for _, b in ipairs(boats) do
		if b.bot.group == 0 and at_home(b) and b.bot.stamina >= cfg.ready_stamina then
			since[b.id] = rested_since[b.id] or ctx.time
			rested[#rested + 1] = b
		end
	end
	rested_since = since

	local muster_sq = cfg.muster_range ^ 2
	while #rested > 0 do
		-- Muster where most rested boats already are.
		local muster, most = nil, 0
		for _, home in ipairs(gamedata.speedboat_homes) do
			local count = 0
			for _, b in ipairs(rested) do
				if distance_sq(b.x, b.y, home[1], home[2]) <= muster_sq then
					count = count + 1
				end
			end
			if count > most then
				muster, most = home, count
			end
		end
		if not muster then
			return
		end

		local candidates, rest = {}, {}
		for _, b in ipairs(rested) do
			if distance_sq(b.x, b.y, muster[1], muster[2]) <= muster_sq then
				candidates[#candidates + 1] = b
			else
				rest[#rest + 1] = b
			end
		end
		table.sort(candidates, function(a, b)
			local da = distance_sq(a.x, a.y, muster[1], muster[2])
			local db = distance_sq(b.x, b.y, muster[1], muster[2])
			if da ~= db then
				return da < db
			end
			return a.id < b.id
		end)
		while #candidates > cfg.max_size do
			table.insert(rest, table.remove(candidates))
		end
		table.sort(rest, function(a, b)
			return a.id < b.id
		end)
		rested = rest

		local waited_alone = false
		for _, b in ipairs(candidates) do
			if ctx.time - rested_since[b.id] >= cfg.lone_wait then
				waited_alone = true
			end
		end
		local watched = nearest_frigate_sq(ctx, muster[1], muster[2]) < cfg.break_off_range ^ 2
		if (#candidates >= cfg.min_size or waited_alone) and not watched then
			local prey = easiest_prey(ctx, muster[1], muster[2])
			if prey then
				local pack = groups.create("pack", {
					phase = "gathering",
					target = prey.id,
					muster = { muster[1], muster[2] },
					formed_at = ctx.time,
				})
				for _, b in ipairs(candidates) do
					b.bot.group = pack.id
					b.bot.target = prey.id
				end
				pack.members = groups.ids(candidates)
			end
		end
	end
end

function M.coordinate(ctx)
	local boats = ctx.bots.swarm_attack

	local members = {}
	for _, b in ipairs(boats) do
		local pack = groups.get(b.bot.group)
		if b.bot.group ~= 0 and not pack then
			pack = restore(b, ctx)
		end
		if pack and pack.kind == "pack" then
			members[pack.id] = members[pack.id] or {}
			table.insert(members[pack.id], b)
		else
			b.bot.group = 0
		end
	end
	for _, pack in ipairs(groups.of_kind("pack")) do
		local list = members[pack.id]
		if list then
			update(pack, list, ctx)
		else
			groups.remove(pack.id)
		end
	end

	form_packs(ctx, boats)
end

return M
