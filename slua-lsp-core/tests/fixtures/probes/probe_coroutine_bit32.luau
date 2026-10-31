-- Probe coroutine and bit32 runtime behavior.
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

show("typeof(coroutine)", typeof(coroutine))
show("typeof(bit32)", typeof(bit32))

-- coroutine probes
try("coroutine.running()", function()
	return coroutine.running()
end)

try("coroutine.isyieldable()", function()
	return coroutine.isyieldable()
end)

local function worker(x)
	show("worker start", x)
	local y = coroutine.yield(x + 1)
	show("worker resumed", y)
	return x + 2, "done"
end

local co
try("coroutine.create(worker)", function()
	co = coroutine.create(worker)
	return co
end)

if co then
	try("coroutine.status(co) (init)", function() return coroutine.status(co) end)
	try("coroutine.resume(co, 10)", function() return coroutine.resume(co, 10) end)
	try("coroutine.status(co) (after yield)", function() return coroutine.status(co) end)
	try("coroutine.resume(co, 99)", function() return coroutine.resume(co, 99) end)
	try("coroutine.status(co) (dead)", function() return coroutine.status(co) end)
	try("coroutine.close(co)", function() return coroutine.close(co) end)
end

try("coroutine.wrap(worker)", function()
	local f = coroutine.wrap(worker)
	show("wrap type", typeof(f))
	local a = f(5)
	show("wrap first", a)
	local b, c = f(7)
	show("wrap second", b, c)
	return typeof(f)
end)

-- bit32 probes
if type(bit32) == 'table' then
	try("bit32.band(6, 3)", function() return bit32.band(6, 3) end)
	try("bit32.bor(6, 3)", function() return bit32.bor(6, 3) end)
	try("bit32.bxor(6, 3)", function() return bit32.bxor(6, 3) end)
	try("bit32.bnot(0)", function() return bit32.bnot(0) end)
	try("bit32.lshift(1, 3)", function() return bit32.lshift(1, 3) end)
	try("bit32.rshift(8, 2)", function() return bit32.rshift(8, 2) end)
	try("bit32.arshift(-8, 2)", function() return bit32.arshift(-8, 2) end)
	try("bit32.lrotate(1, 8)", function() return bit32.lrotate(1, 8) end)
	try("bit32.rrotate(1, 8)", function() return bit32.rrotate(1, 8) end)
	try("bit32.extract(0xFF, 4, 4)", function() return bit32.extract(0xFF, 4, 4) end)
	try("bit32.replace(0xFF, 0, 4, 4)", function() return bit32.replace(0xFF, 0, 4, 4) end)
end
