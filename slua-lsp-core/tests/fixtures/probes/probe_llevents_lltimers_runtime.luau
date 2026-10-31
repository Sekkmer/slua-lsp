-- Probe LLEvents / LLTimers runtime behaviour.
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

show("typeof(LLEvents)", typeof(LLEvents))
show("typeof(LLTimers)", typeof(LLTimers))
show("tostring(LLEvents)", tostring(LLEvents))
show("tostring(LLTimers)", tostring(LLTimers))

try("LLEvents:eventNames()", function()
	local names = LLEvents:eventNames()
	show("eventNames count", #names)
	return names[1]
end)

-- Validate return token shape from on/once and boolean from off.
local handler = function(...)
	show("handler called", select("#", ...), ...)
end

try("LLEvents:on('timer', handler) returns", function()
	local token = LLEvents:on("timer", handler)
	show("token == handler?", token == handler)
	return token
end)

try("LLEvents:off('timer', handler) returns boolean", function()
	return LLEvents:off("timer", handler)
end)

try("LLEvents:once('timer', handler) returns", function()
	local token = LLEvents:once("timer", handler)
	return token
end)

-- Unsupported event names should error.
try("LLEvents:on('___not_an_event___')", function()
	return LLEvents:on("___not_an_event___", function() end)
end)

-- Listeners should include a protected internal timer wrapper.
try("LLEvents:listeners('timer')", function()
	local list = LLEvents:listeners("timer")
	show("listeners count", #list)
	if #list > 0 then
		show("listeners[1] typeof", typeof(list[1]), tostring(list[1]))
	end
	return #list
end)

-- LLTimers behaviour
local tfn = function()
	show("timer fired")
end

try("LLTimers:every(0.1, tfn) returns", function()
	local token = LLTimers:every(0.1, tfn)
	show("token == tfn?", token == tfn)
	return token
end)

try("LLTimers:once(0.1, tfn) returns", function()
	local token = LLTimers:once(0.1, tfn)
	show("token == tfn?", token == tfn)
	return token
end)

try("LLTimers:off(tfn) returns boolean", function()
	return LLTimers:off(tfn)
end)

try("LLTimers:every(-1, tfn) errors", function()
	return LLTimers:every(-1, tfn)
end)
