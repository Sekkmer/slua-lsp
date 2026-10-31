-- Probe script: rotation/quaternion surface + instance field access.
--
-- Goals:
-- 1) Confirm whether rotation + quaternion are the same runtime type.
-- 2) Confirm call style for module functions (dot-call vs colon-call).
-- 3) Check whether vector/rotation/quaternion expose x/y/z(/w) fields even if
--    they do not show up in module key enumeration (likely via metatable __index).
--
-- Paste output lines starting with: slua-test\trotquat\t...

local function t(v)
	if typeof ~= nil then
		return tostring(typeof(v))
	end
	return tostring(type(v))
end

local function sanitizeInline(s)
	s = tostring(s)
	s = string.gsub(s, '\t', '\\t')
	s = string.gsub(s, '\r', '\\r')
	s = string.gsub(s, '\n', '\\n')
	return s
end

local function valueToString(v)
	local tv = t(v)
	if tv == 'nil' then return 'nil' end
	if tv == 'string' then return '"' .. sanitizeInline(v) .. '"' end
	if tv == 'number' or tv == 'boolean' then return sanitizeInline(v) end
	-- userdata/custom types: tostring often returns a useful repr
	return sanitizeInline(tostring(v))
end

local function sortedStringKeys(tbl, maxKeys)
	if type(tbl) ~= 'table' then return {} end
	local keys = {}
	for k, _ in pairs(tbl) do
		if type(k) == 'string' then keys[#keys + 1] = k end
	end
	table.sort(keys)
	if maxKeys and #keys > maxKeys then
		local out = {}
		for i = 1, maxKeys do out[i] = keys[i] end
		return out
	end
	return keys
end

local function probeValue(label, v)
	print('slua-test\trotquat\tval\t' .. label .. '\t' .. t(v) .. '\t' .. valueToString(v))
	if type(v) == 'table' then
		local keys = sortedStringKeys(v, 50)
		if #keys > 0 then
			print('slua-test\trotquat\tkeys\t' .. label .. '\t' .. table.concat(keys, ','))
		end
	end
	local mt = getmetatable(v)
	if mt ~= nil then
		print('slua-test\trotquat\tmt\t' .. label .. '\t' .. t(mt))
		if type(mt) == 'table' then
			local mtKeys = sortedStringKeys(mt, 50)
			if #mtKeys > 0 then
				print('slua-test\trotquat\tmtkeys\t' .. label .. '\t' .. table.concat(mtKeys, ','))
			end
		end
	end
end

local function probeCall(label, fn)
	local ok, a = pcall(fn)
	if not ok then
		print('slua-test\trotquat\tcall\t' .. label .. '\terror\t' .. sanitizeInline(a))
		return false
	end
	print('slua-test\trotquat\tcall\t' .. label .. '\tok\t1=' .. t(a) .. '\t' .. valueToString(a))
	return true, a
end

local function probeGet(label, getter)
	local ok, v = pcall(getter)
	if not ok then
		print('slua-test\trotquat\tget\t' .. label .. '\terror\t' .. sanitizeInline(v))
		return false
	end
	print('slua-test\trotquat\tget\t' .. label .. '\tok\t' .. t(v) .. '\t' .. valueToString(v))
	return true, v
end

local function probeFieldAccess(objLabel, obj, field)
	probeGet(objLabel .. '.' .. field, function() return obj[field] end)
end

local function probeIndexAccess(objLabel, obj, index)
	probeGet(objLabel .. '[' .. tostring(index) .. ']', function() return obj[index] end)
end

local function method(receiverLabel, receiver, name)
	return function(...)
		local args = { ... }
		probeCall(receiverLabel .. '.' .. name, function()
			return receiver[name](table.unpack(args))
		end)
		probeCall(receiverLabel .. ':' .. name, function()
			return receiver[name](receiver, table.unpack(args))
		end)
	end
end

local function tryMakeVector()
	if type(vector) == 'table' and type(vector.create) == 'function' then
		local ok, v = pcall(function() return vector.create(1, 2, 3) end)
		if ok then return v end
	end
	if type(tovector) == 'function' then
		local ok, v = pcall(function() return tovector('<1,2,3>') end)
		if ok then return v end
	end
	if type(vector) == 'function' then
		local ok, v = pcall(function() return vector(1, 2, 3) end)
		if ok then return v end
	end
	return nil
end

local function tryMakeQuatLike(kind)
	-- kind: 'rotation' or 'quaternion'
	local mod = _G[kind]
	if type(mod) == 'table' and type(mod.create) == 'function' then
		local ok, v = pcall(function() return mod.create(0, 0, 0, 1) end)
		if ok then return v end
	end
	-- conversion helpers appear to return 'quaternion' in out2.txt for torotation/toquaternion
	if kind == 'rotation' and type(torotation) == 'function' then
		local ok, v = pcall(function() return torotation('<0,0,0,1>') end)
		if ok then return v end
	end
	if kind == 'quaternion' and type(toquaternion) == 'function' then
		local ok, v = pcall(function() return toquaternion('<0,0,0,1>') end)
		if ok then return v end
	end
	if type(mod) == 'function' then
		local ok, v = pcall(function() return mod(0, 0, 0, 1) end)
		if ok then return v end
	end
	return nil
end

print('slua-test\trotquat\tbegin')

-- Raw globals/modules
probeValue('vector', _G.vector)
probeValue('rotation', _G.rotation)
probeValue('quaternion', _G.quaternion)

-- Construct sample values
local v = tryMakeVector()
if v ~= nil then
	probeValue('sample.vector', v)
	-- Field access often comes from metatable __index, so it won't show up in pairs().
	probeFieldAccess('sample.vector', v, 'x')
	probeFieldAccess('sample.vector', v, 'y')
	probeFieldAccess('sample.vector', v, 'z')
	probeIndexAccess('sample.vector', v, 1)
	probeIndexAccess('sample.vector', v, 2)
	probeIndexAccess('sample.vector', v, 3)
else
	print('slua-test\trotquat\twarn\tsample.vector\tcould-not-construct')
end

local r = tryMakeQuatLike('rotation')
if r ~= nil then
	probeValue('sample.rotation', r)
	probeFieldAccess('sample.rotation', r, 'x')
	probeFieldAccess('sample.rotation', r, 'y')
	probeFieldAccess('sample.rotation', r, 'z')
	probeFieldAccess('sample.rotation', r, 'w')
	probeIndexAccess('sample.rotation', r, 1)
	probeIndexAccess('sample.rotation', r, 2)
	probeIndexAccess('sample.rotation', r, 3)
	probeIndexAccess('sample.rotation', r, 4)
else
	print('slua-test\trotquat\twarn\tsample.rotation\tcould-not-construct')
end

local q = tryMakeQuatLike('quaternion')
if q ~= nil then
	probeValue('sample.quaternion', q)
	probeFieldAccess('sample.quaternion', q, 'x')
	probeFieldAccess('sample.quaternion', q, 'y')
	probeFieldAccess('sample.quaternion', q, 'z')
	probeFieldAccess('sample.quaternion', q, 'w')
	probeIndexAccess('sample.quaternion', q, 1)
	probeIndexAccess('sample.quaternion', q, 2)
	probeIndexAccess('sample.quaternion', q, 3)
	probeIndexAccess('sample.quaternion', q, 4)
else
	print('slua-test\trotquat\twarn\tsample.quaternion\tcould-not-construct')
end

-- Compare rotation/quaternion types + metatables if both exist
if r ~= nil and q ~= nil then
	print('slua-test\trotquat\tcompare\ttypeof\trotation=' .. t(r) .. '\tquaternion=' .. t(q))
	local okMtR, mtR = pcall(getmetatable, r)
	local okMtQ, mtQ = pcall(getmetatable, q)
	if okMtR and okMtQ and mtR ~= nil and mtQ ~= nil then
		print('slua-test\trotquat\tcompare\tmetatable_eq\t' .. tostring(mtR == mtQ))
	end
end

-- Probe module function call style and return types
local function probeRotQuatModule(kind)
	local mod = _G[kind]
	probeValue(kind .. '.module', mod)
	if type(mod) ~= 'table' then return end

	-- Identity value (if present)
	if mod.identity ~= nil then
		probeValue(kind .. '.identity', mod.identity)
		probeFieldAccess(kind .. '.identity', mod.identity, 'x')
		probeFieldAccess(kind .. '.identity', mod.identity, 'y')
		probeFieldAccess(kind .. '.identity', mod.identity, 'z')
		probeFieldAccess(kind .. '.identity', mod.identity, 'w')
	end

	local a = r
	local b = q
	-- Prefer constructing kind-specific samples
	local k1 = tryMakeQuatLike(kind)
	local k2 = tryMakeQuatLike(kind)
	if k1 ~= nil then a = k1 end
	if k2 ~= nil then b = k2 end

	local callCreate = method(kind, mod, 'create')
	local callConjugate = method(kind, mod, 'conjugate')
	local callDot = method(kind, mod, 'dot')
	local callMagnitude = method(kind, mod, 'magnitude')
	local callNormalize = method(kind, mod, 'normalize')
	local callSlerp = method(kind, mod, 'slerp')
	local callTofwd = method(kind, mod, 'tofwd')
	local callToleft = method(kind, mod, 'toleft')
	local callToup = method(kind, mod, 'toup')

	if type(mod.create) == 'function' then callCreate(0, 0, 0, 1) end
	if a ~= nil and type(mod.conjugate) == 'function' then callConjugate(a) end
	if a ~= nil and b ~= nil and type(mod.dot) == 'function' then callDot(a, b) end
	if a ~= nil and type(mod.magnitude) == 'function' then callMagnitude(a) end
	if a ~= nil and type(mod.normalize) == 'function' then callNormalize(a) end
	if a ~= nil and b ~= nil and type(mod.slerp) == 'function' then callSlerp(a, b, 0.5) end
	if a ~= nil and type(mod.tofwd) == 'function' then callTofwd(a) end
	if a ~= nil and type(mod.toleft) == 'function' then callToleft(a) end
	if a ~= nil and type(mod.toup) == 'function' then callToup(a) end
end

probeRotQuatModule('rotation')
probeRotQuatModule('quaternion')

print('slua-test\trotquat\tend')
