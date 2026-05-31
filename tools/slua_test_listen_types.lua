-- Minimal runtime test helper for the stable `listen` event.
--
-- Usage:
-- - Run this script.
-- - Make sure the object is listening on channel 0.
-- - Speak on channel 0 nearby to trigger the event.
--
-- It prints the *runtime* types of the event arguments.

local function t(v)
	-- `typeof` exists in this runtime and is usually more informative than `type`.
	if typeof ~= nil then
		return tostring(typeof(v))
	end
	return tostring(type(v))
end

local function sanitizeInline(s)
	-- Keep output single-line + tab-safe.
	s = tostring(s)
	s = string.gsub(s, '\t', '\\t')
	s = string.gsub(s, '\r', '\\r')
	s = string.gsub(s, '\n', '\\n')
	return s
end

local function summarizeTable(tbl)
	if type(tbl) ~= 'table' then return nil end
	local count = 0
	local stringKeys = 0
	local numberKeys = 0
	for k, _ in pairs(tbl) do
		count = count + 1
		local kt = type(k)
		if kt == 'string' then stringKeys = stringKeys + 1 end
		if kt == 'number' then numberKeys = numberKeys + 1 end
		if count >= 50 then break end
	end
	return 'table(count>=' .. tostring(count) .. ', numberKeys=' .. tostring(numberKeys) .. ', stringKeys=' .. tostring(stringKeys) .. ')'
end

local function sortedStringKeys(tbl, maxKeys)
	local keys = {}
	for k, _ in pairs(tbl) do
		if type(k) == 'string' then
			keys[#keys + 1] = k
		end
	end
	table.sort(keys)
	if maxKeys and #keys > maxKeys then
		local out = {}
		for i = 1, maxKeys do out[i] = keys[i] end
		return out
	end
	return keys
end

local function dumpArray(label, value, maxItems)
	if type(value) ~= 'table' then
		print('slua-test\tprobe\t' .. label .. '\tnot-table\t' .. t(value))
		return
	end
	maxItems = maxItems or 10
	local n = #value
	print('slua-test\tprobe\t' .. label .. '\tlen=' .. tostring(n))
	local limit = n
	if limit > maxItems then limit = maxItems end
	for i = 1, limit do
		local item = value[i]
		local itemType = t(item)
		local extra = ''
		if type(item) == 'string' then
			local s = item
			if #s > 80 then s = string.sub(s, 1, 80) .. '…' end
			extra = '\tvalue="' .. sanitizeInline(s) .. '"'
		elseif type(item) == 'table' then
			local keys = sortedStringKeys(item, 8)
			if #keys > 0 then
				extra = '\tkeys=' .. table.concat(keys, ',')
			end
		end
		print('slua-test\tprobe\t' .. label .. '\titem\t' .. tostring(i) .. '\t' .. itemType .. extra)
	end
end

local function probeCall(label, fn)
	local ok, value = pcall(fn)
	if not ok then
		print('slua-test\tprobe\t' .. label .. '\terror\t' .. tostring(value))
		return
	end
	local summary = summarizeTable(value)
	if summary ~= nil then
		print('slua-test\tprobe\t' .. label .. '\t' .. summary)
	else
		print('slua-test\tprobe\t' .. label .. '\t' .. t(value))
	end
	return value
end

print('slua-test\tlisten\tbegin')

-- Register for channel 0 (open chat). This is the standard LSL listen registration.
-- NOTE: this only registers the listener; the `listen` event fires when someone speaks.
if ll and ll.Listen then
	ll.Listen(0, '', '', '')
	print('slua-test\tlisten\tregistered\tchannel=0')
else
	print('slua-test\tlisten\twarn\tll.Listen missing')
end

-- Intentionally declare 5 params so you can see whether a 5th is ever provided.
LLEvents:on('listen', function(channel, name, id, text, extra)
	print('slua-test\tlisten\targs\t' ..
		'1=' .. t(channel) .. '\t' ..
		'2=' .. t(name) .. '\t' ..
		'3=' .. t(id) .. '\t' ..
		'4=' .. t(text) .. '\t' ..
		'5=' .. t(extra))
end)

-- Probe LLEvents helpers discovered via metatable.
local names = probeCall('LLEvents:eventNames()', function()
	return LLEvents:eventNames()
end)
	if names ~= nil then
		dumpArray('LLEvents:eventNames()', names, 20)
	end

probeCall('LLEvents:listeners()', function()
	return LLEvents:listeners()
end)

local ls = probeCall('LLEvents:listeners("listen")', function()
	return LLEvents:listeners('listen')
end)
	if ls ~= nil then
		dumpArray('LLEvents:listeners("listen")', ls, 20)
	end

print('slua-test\tlisten\tend')
