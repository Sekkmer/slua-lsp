-- Probe instance member functions for vector/rotation/quaternion in SLua runtime.
--
-- This script tries to answer:
--   - Which functions exist on the module tables (vector/rotation/quaternion)
--   - Which of those functions are actually available as instance members
--     via `v:name(...)` / `r:name(...)`
--   - For a small set of common methods, attempt a safe call to learn return types.

local function safe_tostring(v)
	local ok, s = pcall(tostring, v)
	if ok then return s end
	return "<tostring error>"
end

local function safe_typeof(v)
	if typeof then
		local ok, t = pcall(typeof, v)
		if ok then return t end
	end
	return type(v)
end

local function pack(...)
	return { n = select("#", ...), ... }
end

local function describe_returns(p)
	if type(p) ~= "table" then return "<not packed>" end
	if (p.n or 0) == 0 then return "(no returns)" end
	local parts = {}
	for i = 1, p.n do
		local v = p[i]
		parts[#parts + 1] = "#" .. tostring(i) .. " (" .. safe_typeof(v) .. ") " .. safe_tostring(v)
	end
	return table.concat(parts, "; ")
end

local function get_metatable_summary(obj)
	local ok, mt = pcall(getmetatable, obj)
	if not ok then return "<getmetatable error: " .. safe_tostring(mt) .. ">" end
	if type(mt) ~= "table" then return "(" .. type(mt) .. ") " .. safe_tostring(mt) end
	local idx = mt.__index
	return "mt.__type=" .. safe_tostring(mt.__type) .. " mt.__index=" .. type(idx)
end

local function try_get(obj, key)
	local ok, v = pcall(function()
		return (obj :: any)[key]
	end)
	if not ok then
		return false, nil, safe_tostring(v)
	end
	return true, v, nil
end

local function try_call_method(obj, name, args)
	args = args or {}
	local okGet, fn, err = try_get(obj, name)
	if not okGet then
		return false, nil, "get failed: " .. safe_tostring(err)
	end
	if type(fn) ~= "function" then
		return false, nil, "not a function (" .. type(fn) .. ")"
	end

	-- Prefer colon semantics (self as first arg). If that errors, try calling without self.
	local ok1, r1, r2, r3, r4, r5, r6 = pcall(fn, obj, table.unpack(args))
	if ok1 then
		return true, pack(r1, r2, r3, r4, r5, r6), "called with self"
	end
	local ok2, s1, s2, s3, s4, s5, s6 = pcall(fn, table.unpack(args))
	if ok2 then
		return true, pack(s1, s2, s3, s4, s5, s6), "called without self"
	end
	return false, nil, "call failed: " .. safe_tostring(r1) .. " ; " .. safe_tostring(s1)
end

local function try_call_module(mod, name, args)
	args = args or {}
	local fn = mod[name]
	if type(fn) ~= "function" then
		return false, nil, "module[" .. name .. "] not a function (" .. type(fn) .. ")"
	end
	local ok, r1, r2, r3, r4, r5, r6 = pcall(fn, table.unpack(args))
	if not ok then
		return false, nil, safe_tostring(r1)
	end
	return true, pack(r1, r2, r3, r4, r5, r6), nil
end

local function summarize_member_lookup(instance, name)
	local ok, v, err = try_get(instance, name)
	if not ok then
		return "<missing> (lookup error: " .. safe_tostring(err) .. ")"
	end
	return "(" .. type(v) .. ") " .. safe_tostring(v)
end

local function list_module_functions(mod)
	local names = {}
	for k, v in pairs(mod) do
		if type(k) == "string" and type(v) == "function" then
			names[#names + 1] = k
		end
	end
	table.sort(names)
	return names
end

local function probe_type(label, moduleTable, makeInstance)
	print("\n=== PROBE " .. label .. " ===")
	print("module typeof=" .. safe_typeof(moduleTable) .. " tostring=" .. safe_tostring(moduleTable))

	local instance = makeInstance()
	print("instance typeof=" .. safe_typeof(instance) .. " tostring=" .. safe_tostring(instance))
	print("instance metatable: " .. get_metatable_summary(instance))

	local fnNames = list_module_functions(moduleTable)
	print("module function count=" .. tostring(#fnNames))

	-- Which module functions appear as instance members?
	local memberFns = {}
	for _, name in ipairs(fnNames) do
		local ok, v = try_get(instance, name)
		if ok and type(v) == "function" then
			memberFns[#memberFns + 1] = name
		end
	end
	print("instance member functions (from module names) count=" .. tostring(#memberFns))
	if #memberFns > 0 then
		print("members: " .. table.concat(memberFns, ", "))
	end

	-- Probe common instance fields
	local fieldKeys = { "x", "y", "z", "s", "w" }
	for _, k in ipairs(fieldKeys) do
		local ok, v, err = try_get(instance, k)
		if ok then
			print("field ." .. k .. " => (" .. safe_typeof(v) .. ") " .. safe_tostring(v))
		else
			-- many types will error on unknown fields; keep it compact
		end
	end

	-- Best-effort calls for common methods to infer return types.
	local samples = {}
	if label == "vector" then
		local v2 = vector(4, 5, 6)
		samples = {
			abs = {},
			ceil = {},
			floor = {},
			magnitude = {},
			normalize = {},
			sign = {},
			dot = { v2 },
			cross = { v2 },
			angle = { v2 },
			min = { v2 },
			max = { v2 },
			clamp = { vector(0, 0, 0), vector(10, 10, 10) }
		}
	elseif label == "rotation" or label == "quaternion" then
		local r2 = rotation(0, 0, 0, 1)
		samples = {
			conjugate = {},
			magnitude = {},
			normalize = {},
			tofwd = {},
			toleft = {},
			toup = {},
			dot = { r2 },
			slerp = { r2, 0.5 }
		}
	end

	for name, args in pairs(samples) do
		print("\n-- function " .. label .. "." .. name)
		print("instance lookup: " .. summarize_member_lookup(instance, name))

		-- 1) Try instance member style (if it exists)
		local okM, retM, howM = try_call_method(instance, name, args)
		if okM then
			print("instance call (member) with args=" .. tostring(#args) .. " => " .. describe_returns(retM) .. " [" .. howM .. "]")
		else
			print("instance call (member) with args=" .. tostring(#args) .. " failed: " .. safe_tostring(howM))
		end

		-- 2) Try module function style with correct receiver
		local ok1, ret1, err1 = try_call_module(moduleTable, name, { instance, table.unpack(args) })
		if ok1 then
			print("module call receiver-first => " .. describe_returns(ret1))
		else
			print("module call receiver-first failed: " .. safe_tostring(err1))
		end

		-- 3) Try module call without receiver (should usually fail; useful to confirm)
		local ok2, ret2, err2 = try_call_module(moduleTable, name, args)
		if ok2 then
			print("module call without receiver => " .. describe_returns(ret2))
		else
			print("module call without receiver failed: " .. safe_tostring(err2))
		end

		-- 4) Try module call with extra args (to see if it ignores extras)
		local ok3, ret3, err3 = try_call_module(moduleTable, name, { instance, table.unpack(args), nil, nil })
		if ok3 then
			print("module call receiver-first + extras => " .. describe_returns(ret3))
		else
			print("module call receiver-first + extras failed: " .. safe_tostring(err3))
		end
	end
end

-- vector
probe_type("vector", vector, function()
	return vector(1, 2, 3)
end)

-- rotation
probe_type("rotation", rotation, function()
	return rotation(0, 0, 0, 1)
end)

-- quaternion is typically an alias to rotation in SLua
probe_type("quaternion", quaternion, function()
	return quaternion(0, 0, 0, 1)
end)

print("\n(probe_instance_members_vector_rotation) done")
