-- Group records (convoys, packs) shared by the coordinators that decide them
-- and the behaviors that carry them out.
--
-- Membership lives on each bot (bot.group), which the hosts persist with the
-- rest of the bot state. Records only live in the VM, so a rebuilt VM starts
-- without them; coordinators restore a missing record from its members the
-- next time they run.

local M = {}

local records = {}
local next_id = 1

--- The record with this id, or nil (0 means "no group").
function M.get(id)
	if id == nil or id == 0 then
		return nil
	end
	return records[id]
end

--- Keep new ids clear of every id a bot already carries, so a rebuilt VM
--- never hands out an id that a surviving group still uses.
function M.reserve_ids(entities)
	for _, e in ipairs(entities) do
		if e.bot and e.bot.group >= next_id then
			next_id = e.bot.group + 1
		end
	end
end

function M.create(kind, fields)
	fields.id = next_id
	fields.kind = kind
	fields.members = fields.members or {}
	records[next_id] = fields
	next_id = next_id + 1
	return fields
end

--- Recreate the record for an id that bots still carry after a VM rebuild.
function M.restore(id, kind, fields)
	fields.id = id
	fields.kind = kind
	fields.members = {}
	records[id] = fields
	return fields
end

function M.remove(id)
	records[id] = nil
end

--- Records of one kind in id order, so both hosts visit them identically.
function M.of_kind(kind)
	local list = {}
	for _, record in pairs(records) do
		if record.kind == kind then
			list[#list + 1] = record
		end
	end
	table.sort(list, function(a, b)
		return a.id < b.id
	end)
	return list
end

--- Members still alive and under AI control, in the record's order.
function M.alive_members(record, ctx)
	local alive = {}
	for _, id in ipairs(record.members) do
		local e = ctx.by_id[id]
		if e and e.bot and e.bot.group == record.id then
			alive[#alive + 1] = e
		end
	end
	return alive
end

function M.centre(entities)
	local x, y = 0.0, 0.0
	for _, e in ipairs(entities) do
		x = x + e.x
		y = y + e.y
	end
	return x / #entities, y / #entities
end

function M.ids(entities)
	local ids = {}
	for i, e in ipairs(entities) do
		ids[i] = e.id
	end
	return ids
end

return M
