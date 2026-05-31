-- Probe PRIM_* constant surface and their runtime types.
-- Intended to be run inside the SLua VM.

local function show(label: string, ...)
	print(label, ...)
end

if type(ll) ~= 'table' then
	show('ll is not a table', typeof(ll))
	return
end

local keys = {}
for k, _ in pairs(ll) do
	if type(k) == 'string' and string.sub(k, 1, 5) == 'PRIM_' then
		table.insert(keys, k)
	end
end

table.sort(keys)
show('PRIM_* count', #keys)

-- Print a manageable subset; adjust limit if needed.
local LIMIT = 120
for i = 1, math.min(#keys, LIMIT) do
	local k = keys[i]
	local v = ll[k]
	show(k, typeof(v), v)
end

if #keys > LIMIT then
	show('... truncated, increase LIMIT to see more')
end
