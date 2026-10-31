-- Probe lljson / llbase64 runtime behaviour.
-- Intended to be run inside the SLua VM.

local function show(label: string, ...)
	print(label, ...)
end

local function try(label: string, fn)
	local ok, a, b, c, d = pcall(fn)
	if ok then
		show(label .. " => ok", a, b, c, d)
	else
		show(label .. " => err", a)
	end
end

show("typeof(lljson)", typeof(lljson))
show("typeof(llbase64)", typeof(llbase64))

if type(lljson) == 'table' then
	show("lljson keys", table.concat((function()
		local keys = {}
		for k, _ in pairs(lljson) do table.insert(keys, tostring(k)) end
		table.sort(keys)
		return keys
	end)(), ","))

	try("lljson.encode(null)", function() return lljson.encode(lljson.null) end)
	try("lljson.encode(empty_array)", function() return lljson.encode(lljson.empty_array) end)
	try("lljson.encode({})", function() return lljson.encode({}) end)
	try("lljson.encode(array_mt)", function() return lljson.encode(setmetatable({}, lljson.array_mt)) end)
	try("lljson.encode({a=1,b='x',c=true})", function() return lljson.encode({ a = 1, b = 'x', c = true }) end)

	-- Interesting SLua types
	local v = vector(1, 2, 3)
	local q = quaternion(0, 0, 0, 1)
	local id = (uuid and uuid.create and uuid.create('00000000-0000-0000-0000-000000000000')) or nil
	local buf = (buffer and buffer.create and buffer.create(4)) or nil
	if buf and buffer.writeu8 then
		buffer.writeu8(buf, 0, 0x01)
		buffer.writeu8(buf, 1, 0x02)
		buffer.writeu8(buf, 2, 0x03)
		buffer.writeu8(buf, 3, 0x04)
	end

	try("lljson.encode({v=v})", function() return lljson.encode({ v = v }) end)
	try("lljson.encode({q=q})", function() return lljson.encode({ q = q }) end)
	try("lljson.encode({id=id})", function() return lljson.encode({ id = id }) end)
	try("lljson.encode({buf=buf})", function() return lljson.encode({ buf = buf }) end)

	-- Decode roundtrip sanity
	try("lljson.decode(encode({a=1}))", function()
		local s = lljson.encode({ a = 1 })
		local t = lljson.decode(s)
		return type(t), t.a
	end)

	-- SL encode/decode variants (if present)
	if type(lljson.slencode) == 'function' and type(lljson.sldecode) == 'function' then
		try("lljson.slencode({v=v,q=q})", function() return lljson.slencode({ v = v, q = q }) end)
		try("lljson.sldecode(slencode(...))", function()
			local s = lljson.slencode({ v = v, q = q })
			local t = lljson.sldecode(s)
			return type(t), typeof(t.v), typeof(t.q)
		end)
	end
end

if type(llbase64) == 'table' then
	show("llbase64 keys", table.concat((function()
		local keys = {}
		for k, _ in pairs(llbase64) do table.insert(keys, tostring(k)) end
		table.sort(keys)
		return keys
	end)(), ","))

	local buf = (buffer and buffer.create and buffer.create(4)) or nil
	if buf and buffer.writeu8 then
		buffer.writeu8(buf, 0, 0x01)
		buffer.writeu8(buf, 1, 0x00)
		buffer.writeu8(buf, 2, 0xff)
		buffer.writeu8(buf, 3, 0x00)
	end

	try("llbase64.encode('hello')", function() return llbase64.encode('hello') end)
	try("llbase64.decode('aGVsbG8=')", function() return llbase64.decode('aGVsbG8=') end)

	if buf then
		try("llbase64.encode(buffer)", function() return llbase64.encode(buf) end)
		try("llbase64.decode(..., true) => buffer", function()
			local out = llbase64.decode('AQD/AA==', true)
			return typeof(out), buffer.len(out)
		end)
	end

	try("llbase64.decode truncation", function()
		local s = llbase64.decode('foo<bar')
		return llbase64.encode(s)
	end)

	try("llbase64.decode incomplete padding", function()
		local s = llbase64.decode('foobar')
		return llbase64.encode(s)
	end)
end
