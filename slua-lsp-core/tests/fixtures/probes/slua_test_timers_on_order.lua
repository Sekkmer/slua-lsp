-- Runtime probe for LLTimers:on(...) parameter order.
--
-- Goal: discover whether LLTimers:on expects (seconds, callback) or (callback, seconds)
-- and whether the callback receives an extra leading parameter.
--
-- Usage:
-- - Run this script in-world.
-- - Wait a few seconds for any timer callbacks to fire.
-- - Paste the output lines starting with: slua-test\ttimers-on\t...

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

local function probeCall(label, fn)
	local ok, value = pcall(fn)
	if not ok then
		print('slua-test\ttimers-on\t' .. label .. '\terror\t' .. sanitizeInline(value))
		return false, nil
	end
	print('slua-test\ttimers-on\t' .. label .. '\tok\tret=' .. t(value))
	return true, value
end

local function describeIndex(receiver)
	local mt = getmetatable(receiver)
	if not mt then
		print('slua-test\ttimers-on\tLLTimers\tmt\tnil')
		return
	end
	print('slua-test\ttimers-on\tLLTimers\tmt\t' .. t(mt))
	local idx = mt.__index
	print('slua-test\ttimers-on\tLLTimers\tmt.__index\t' .. t(idx))
	if type(idx) == 'table' then
		local keys = {}
		for k, _ in pairs(idx) do
			if type(k) == 'string' then
				keys[#keys + 1] = k
			end
		end
		table.sort(keys)
		print('slua-test\ttimers-on\tLLTimers\tindex.keys\t' .. table.concat(keys, ','))
	end
end

local fired = 0
local function makeCallback(label)
	return function(...)
		fired = fired + 1
		local n = select('#', ...)
		local first = select(1, ...)
		local firstInline = ''
		local firstType = t(first)
		if type(first) == 'string' or type(first) == 'number' or type(first) == 'boolean' then
			firstInline = '\tfirst=' .. sanitizeInline(first)
		end
		print(
			'slua-test\ttimers-on\tcb\t' .. label ..
			'\tn=' .. tostring(n) ..
			'\tfirstType=' .. firstType ..
			firstInline
		)

		-- Also print all arg types (compact).
		local parts = {}
		for i = 1, n do
			parts[i] = tostring(i) .. '=' .. t(select(i, ...))
		end
		print('slua-test\ttimers-on\tcb-args\t' .. label .. '\t' .. table.concat(parts, '\t'))

		if fired >= 10 then
			print('slua-test\ttimers-on\tcb\twarn\ttoo-many-callbacks; stopping log')
		end
	end
end

local function sleepSeconds(seconds)
	if ll and type(ll.Sleep) == 'function' then
		ll.Sleep(seconds)
		return true
	end
	if type(wait) == 'function' then
		wait(seconds)
		return true
	end
	if os and type(os.clock) == 'function' then
		local start = os.clock()
		while (os.clock() - start) < seconds do end
		return true
	end
	return false
end

print('slua-test\ttimers-on\tbegin')

if LLTimers == nil then
	print('slua-test\ttimers-on\terror\tLLTimers is nil')
	return
end

print('slua-test\ttimers-on\tLLTimers\ttype\t' .. t(LLTimers))
describeIndex(LLTimers)

-- If :on doesn't exist at all, we still attempt calls to get the runtime error message.
local haveOn = false
local okHas, has = pcall(function()
	-- Prefer raw access: may throw if __index is weird.
	return LLTimers.on ~= nil
end)
if okHas then
	haveOn = (has == true)
end
print('slua-test\ttimers-on\tLLTimers.on\tpresent\t' .. tostring(haveOn))

-- Try a few plausible signatures.
local seconds = 0.5
local cbA = makeCallback('A_seconds_cb')
local cbB = makeCallback('B_cb_seconds')
local cbC = makeCallback('C_seconds_cb_extra')

local ok1, ret1 = probeCall('call\tLLTimers:on(seconds, cb)', function()
	return LLTimers:on(seconds, cbA)
end)

local ok2, ret2 = probeCall('call\tLLTimers:on(cb, seconds)', function()
	return LLTimers:on(cbB, seconds)
end)

local ok3, ret3 = probeCall('call\tLLTimers:on(seconds, cb, "tag")', function()
	return LLTimers:on(seconds, cbC, 'tag')
end)

-- Summarize return values; sometimes this is a handle used for off().
local function summarizeRet(label, ok, ret)
	if not ok then return end
	print('slua-test\ttimers-on\tret\t' .. label .. '\t' .. t(ret) .. '\t' .. sanitizeInline(ret))
end

summarizeRet('1', ok1, ret1)
summarizeRet('2', ok2, ret2)
summarizeRet('3', ok3, ret3)

-- Give callbacks a chance to fire.
local slept = sleepSeconds(3)
if not slept then
	print('slua-test\ttimers-on\twarn\tno sleep available; keep script running for ~3s to see callbacks')
end

print('slua-test\ttimers-on\tend')
