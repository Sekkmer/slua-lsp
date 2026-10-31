-- Runtime probe script for LLTimers and legacy ll.SetTimerEvent.
-- Goal: confirm signatures/return values and whether the legacy timer event pathway exists.
--
-- Output is diff-friendly: tab-separated.

local function sanitizeInline(s)
	s = tostring(s)
	s = string.gsub(s, '\t', '\\t')
	s = string.gsub(s, '\r', '\\r')
	s = string.gsub(s, '\n', '\\n')
	return s
end

local function t(v)
	if typeof ~= nil then
		return tostring(typeof(v))
	end
	return tostring(type(v))
end

local function emit(kind, name, extra)
	if extra ~= nil and extra ~= '' then
		print('slua-test\ttimers\t' .. kind .. '\t' .. name .. '\t' .. extra)
	else
		print('slua-test\ttimers\t' .. kind .. '\t' .. name)
	end
end

local function probeCall(label, fn)
	local ok, value = pcall(fn)
	if not ok then
		emit('probe', label, 'error\t' .. sanitizeInline(value))
		return nil
	end
	local extra = t(value)
	if value == nil then extra = 'nil' end
	emit('probe', label, extra)
	return value
end

print('slua-test\ttimers\tbegin')

-- Legacy timer API probe
if ll ~= nil then
	probeCall('ll.SetTimerEvent', function()
		return ll.SetTimerEvent
	end)
else
	emit('probe', 'll', 'missing')
end

-- LLTimers presence
probeCall('LLTimers', function()
	-- eslint-disable-next-line no-undef
	return LLTimers
end)

-- Method presence (by direct access)
probeCall('LLTimers.once', function()
	-- eslint-disable-next-line no-undef
	return LLTimers.once
end)
probeCall('LLTimers.every', function()
	-- eslint-disable-next-line no-undef
	return LLTimers.every
end)
probeCall('LLTimers.off', function()
	-- eslint-disable-next-line no-undef
	return LLTimers.off
end)

-- Try calling once/every and see return types.
local function noop() end

local onceHandle = probeCall('LLTimers:once(0.0, fn)', function()
	-- eslint-disable-next-line no-undef
	return LLTimers:once(0.0, noop)
end)

local everyHandle = probeCall('LLTimers:every(0.0, fn)', function()
	-- eslint-disable-next-line no-undef
	return LLTimers:every(0.0, noop)
end)

-- Try turning off timers. We don't know whether off expects a handle, callback, or nothing.
probeCall('LLTimers:off()', function()
	-- eslint-disable-next-line no-undef
	return LLTimers:off()
end)

if onceHandle ~= nil then
	probeCall('LLTimers:off(onceHandle)', function()
		-- eslint-disable-next-line no-undef
		return LLTimers:off(onceHandle)
	end)
end

if everyHandle ~= nil then
	probeCall('LLTimers:off(everyHandle)', function()
		-- eslint-disable-next-line no-undef
		return LLTimers:off(everyHandle)
	end)
end

-- Some APIs use (seconds, callback) to cancel; probe that as well.
probeCall('LLTimers:off(noop)', function()
	-- eslint-disable-next-line no-undef
	return LLTimers:off(noop)
end)

probeCall('LLTimers:off(0.0, noop)', function()
	-- eslint-disable-next-line no-undef
	return LLTimers:off(0.0, noop)
end)

print('slua-test\ttimers\tend')
