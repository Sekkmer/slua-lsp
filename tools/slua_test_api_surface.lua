-- Probe script: quickly sanity-check call style ('.' vs ':') and return types
-- for common SLua runtime surfaces: vector, llbase64, lljson, and conversion helpers.
--
-- Paste output lines starting with: slua-test\tapi\t...

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
	print('slua-test\tapi\tval\t' .. label .. '\t' .. t(v))
	if type(v) == 'table' then
		local keys = sortedStringKeys(v, 30)
		if #keys > 0 then
			print('slua-test\tapi\tkeys\t' .. label .. '\t' .. table.concat(keys, ','))
		end
	end
	local mt = getmetatable(v)
	if mt ~= nil then
		print('slua-test\tapi\tmt\t' .. label .. '\t' .. t(mt))
		if type(mt) == 'table' then
			local mtKeys = sortedStringKeys(mt, 30)
			if #mtKeys > 0 then
				print('slua-test\tapi\tmtkeys\t' .. label .. '\t' .. table.concat(mtKeys, ','))
			end
		end
	end
end

local function probeCall(label, fn)
	local ok, a, b, c, d, e = pcall(fn)
	if not ok then
		print('slua-test\tapi\tcall\t' .. label .. '\terror\t' .. sanitizeInline(a))
		return false
	end
	-- Most APIs return 1 value, but capture a few anyway.
	local retTypes = {
		'1=' .. t(a),
		'2=' .. t(b),
		'3=' .. t(c),
		'4=' .. t(d),
		'5=' .. t(e)
	}
	print('slua-test\tapi\tcall\t' .. label .. '\tok\t' .. table.concat(retTypes, '\t'))
	return true, a
end

local function method(receiverLabel, receiver, name)
	return function(...)
		local args = { ... }
		-- dot-call
		probeCall(receiverLabel .. '.' .. name, function()
			return receiver[name](table.unpack(args))
		end)
		-- colon-call (inject self)
		probeCall(receiverLabel .. ':' .. name, function()
			return receiver[name](receiver, table.unpack(args))
		end)
	end
end

local function tryMakeVector()
	-- Prefer vector.create if vector is a module.
	if type(vector) == 'table' and type(vector.create) == 'function' then
		local ok, v = pcall(function() return vector.create(1, 2, 3) end)
		if ok then return v end
	end
	-- Some runtimes expose tovector("<x,y,z>").
	if type(tovector) == 'function' then
		local ok, v = pcall(function() return tovector('<1,2,3>') end)
		if ok then return v end
	end
	return nil
end

print('slua-test\tapi\tbegin')

-- Globals / helpers
local globals = {
	'vector',
	'rotation',
	'quaternion',
	'tovector',
	'torotation',
	'toquaternion',
	'uuid',
	'touuid',
	'integer',
	'tonumber',
	'tostring'
}
for _, name in ipairs(globals) do
	probeValue(name, _G[name])
end

-- Probe conversion helpers with sample values (best-effort)
if type(tovector) == 'function' then
	probeCall('tovector("<1,2,3>")', function() return tovector('<1,2,3>') end)
end
if type(torotation) == 'function' then
	probeCall('torotation("<0,0,0,1>")', function() return torotation('<0,0,0,1>') end)
end
if type(toquaternion) == 'function' then
	probeCall('toquaternion("<0,0,0,1>")', function() return toquaternion('<0,0,0,1>') end)
end
if type(uuid) == 'function' then
	probeCall('uuid("00000000-0000-0000-0000-000000000000")', function()
		return uuid('00000000-0000-0000-0000-000000000000')
	end)
end
if type(touuid) == 'function' then
	probeCall('touuid("00000000-0000-0000-0000-000000000000")', function()
		return touuid('00000000-0000-0000-0000-000000000000')
	end)
end
if type(rotation) == 'function' then
	probeCall('rotation(0,0,0,1)', function() return rotation(0, 0, 0, 1) end)
end
if type(quaternion) == 'function' then
	probeCall('quaternion(0,0,0,1)', function() return quaternion(0, 0, 0, 1) end)
end

-- vector module
probeValue('vector', vector)
local v1 = tryMakeVector()
local v2 = nil
if v1 ~= nil then
	probeValue('vector.sample.v1', v1)
	-- best-effort second vector
	if type(vector) == 'table' and type(vector.create) == 'function' then
		local ok, v = pcall(function() return vector.create(4, 5, 6) end)
		if ok then v2 = v end
	end
	if v2 == nil and type(tovector) == 'function' then
		local ok, v = pcall(function() return tovector('<4,5,6>') end)
		if ok then v2 = v end
	end
	if v2 ~= nil then probeValue('vector.sample.v2', v2) end

	if type(vector) == 'table' then
		local callAbs = method('vector', vector, 'abs')
		local callAngle = method('vector', vector, 'angle')
		local callCeil = method('vector', vector, 'ceil')
		local callClamp = method('vector', vector, 'clamp')
		local callCross = method('vector', vector, 'cross')
		local callDot = method('vector', vector, 'dot')
		local callFloor = method('vector', vector, 'floor')
		local callMagnitude = method('vector', vector, 'magnitude')
		local callMax = method('vector', vector, 'max')
		local callMin = method('vector', vector, 'min')
		local callNormalize = method('vector', vector, 'normalize')
		local callSign = method('vector', vector, 'sign')

		if type(vector.abs) == 'function' then callAbs(v1) end
		if type(vector.ceil) == 'function' then callCeil(v1) end
		if type(vector.floor) == 'function' then callFloor(v1) end
		if type(vector.magnitude) == 'function' then callMagnitude(v1) end
		if type(vector.normalize) == 'function' then callNormalize(v1) end
		if type(vector.sign) == 'function' then callSign(v1) end

		if v2 ~= nil then
			if type(vector.angle) == 'function' then callAngle(v1, v2) end
			if type(vector.cross) == 'function' then callCross(v1, v2) end
			if type(vector.dot) == 'function' then callDot(v1, v2) end
			if type(vector.max) == 'function' then callMax(v1, v2) end
			if type(vector.min) == 'function' then callMin(v1, v2) end
		end

		-- clamp is ambiguous: try numeric min/max first, then vector min/max
		if type(vector.clamp) == 'function' then
			callClamp(v1, -1, 1)
			if v2 ~= nil then callClamp(v1, v1, v2) end
		end
	end
else
	print('slua-test\tapi\twarn\tvector\tcould-not-construct-sample-vectors')
end

-- llbase64 module
probeValue('llbase64', llbase64)
if type(llbase64) == 'table' then
	local enc = method('llbase64', llbase64, 'encode')
	local dec = method('llbase64', llbase64, 'decode')
	if type(llbase64.encode) == 'function' then enc('hello') end
	if type(llbase64.decode) == 'function' then
		-- decode a known base64 string for "hello" (aGVsbG8=)
		dec('aGVsbG8=')
	end
end

-- lljson module
probeValue('lljson', lljson)
if type(lljson) == 'table' then
	local encode = method('lljson', lljson, 'encode')
	local decode = method('lljson', lljson, 'decode')
	local slencode = method('lljson', lljson, 'slencode')
	local sldecode = method('lljson', lljson, 'sldecode')

	if type(lljson.null) ~= 'nil' then probeValue('lljson.null', lljson.null) end
	if type(lljson.empty_array) ~= 'nil' then probeValue('lljson.empty_array', lljson.empty_array) end

	if type(lljson.encode) == 'function' then
		encode({ a = 1, b = 'x', c = true })
		encode({ 1, 2, 3 })
	end
	if type(lljson.decode) == 'function' then
		decode('{"a":1,"b":"x","c":true}')
		decode('[1,2,3]')
	end
	if type(lljson.slencode) == 'function' then
		slencode({ a = 1, b = 'x' })
	end
	if type(lljson.sldecode) == 'function' then
		sldecode('{"a":1,"b":"x"}')
	end
end

print('slua-test\tapi\tend')
