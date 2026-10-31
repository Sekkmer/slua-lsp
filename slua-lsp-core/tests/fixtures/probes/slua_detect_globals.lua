-- SLua/Luau environment detection script
-- Goal: enumerate globals (functions/modules/objects) deterministically.
-- Notes:
-- - Uses print() for output (in SLua, print effectively goes to ll.OwnerSay).
-- - Ignores primitives (number/string/boolean/nil). Focus is on functions/tables/userdata/threads.
-- - Only scans top-level globals for now.

local function getGlobals()
	-- Prefer _G when present; fall back to _ENV for Luau.
	-- (getfenv(0) is Lua 5.1-ish; may not exist in Luau.)
	if _G ~= nil then return _G end
	if _ENV ~= nil then return _ENV end
	if type(getfenv) == 'function' then
		local ok, env = pcall(getfenv, 0)
		if ok and type(env) == 'table' then return env end
	end
	return {}
end

local function getEnv()
	-- In Luau, `_ENV` is the lexical environment; it may differ from `_G`.
	if _ENV ~= nil then return _ENV end
	return getGlobals()
end

local function rawkeys(t)
	local keys = {}
	for k, _ in next, t, nil do
		if type(k) == 'string' then
			keys[#keys + 1] = k
		end
	end
	table.sort(keys)
	return keys
end

local function fmtType(v)
	local tv = type(v)
	if tv ~= 'userdata' then return tv end
	-- Best effort: include metatable name-ish if available.
	local mt = getmetatable(v)
	if type(mt) == 'table' then
		local name = rawget(mt, '__name')
		if type(name) == 'string' and name ~= '' then
			return 'userdata<' .. name .. '>'
		end
	end
	return 'userdata'
end

local function emit(kind, name, extra)
	if extra ~= nil and extra ~= '' then
		print('slua-detect\t' .. kind .. '\t' .. name .. '\t' .. extra)
	else
		print('slua-detect\t' .. kind .. '\t' .. name)
	end
end

local function sanitizeInline(s)
	-- Keep output single-line + tab-safe.
	s = tostring(s)
	s = string.gsub(s, '\t', '\\t')
	s = string.gsub(s, '\r', '\\r')
	s = string.gsub(s, '\n', '\\n')
	return s
end

local function fmtPrimitiveValue(v)
	local tv = type(v)
	if tv == 'string' then
		local s = v
		if #s > 120 then s = string.sub(s, 1, 120) .. '…' end
		return '"' .. sanitizeInline(s) .. '"'
	end
	if tv == 'number' or tv == 'boolean' then
		return sanitizeInline(v)
	end
	if tv == 'nil' then return 'nil' end
	return nil
end

local function scanUserdata(prefix, u)
	if type(u) ~= 'userdata' then return end
	local okMt, mt = pcall(getmetatable, u)
	if not okMt then
		emit('userdata:metatable', prefix, 'error')
		return
	end

	local mtType = type(mt)
	emit('userdata:metatable', prefix, mtType)
	if mtType ~= 'table' then return end

	-- Dump metatable keys (helps spot __index and friends)
	local mtKeys = rawkeys(mt)
	for i = 1, #mtKeys do
		local k = mtKeys[i]
		local v = rawget(mt, k)
		local tv = type(v)
		if tv == 'function' then
			emit('userdata:mt:function', prefix .. '.' .. k)
		elseif tv == 'table' then
			emit('userdata:mt:table', prefix .. '.' .. k)
		elseif tv == 'userdata' or tv == 'thread' then
			emit('userdata:mt:object', prefix .. '.' .. k, fmtType(v))
		else
			local pv = fmtPrimitiveValue(v)
			if pv ~= nil then
				emit('userdata:mt:value', prefix .. '.' .. k, tv .. '=' .. pv)
			else
				emit('userdata:mt:value', prefix .. '.' .. k, tv)
			end
		end
	end

	local idx = rawget(mt, '__index')
	local idxType = type(idx)
	emit('userdata:mt:__index', prefix, idxType)

	-- If __index is a table, we can enumerate members.
	if idxType == 'table' then
		local keys = rawkeys(idx)
		for i = 1, #keys do
			local k = keys[i]
			local rawMember = rawget(idx, k)
			local rawTv = type(rawMember)
			if rawTv == 'function' then
				emit('userdata:member:function', prefix .. '.' .. k)
			elseif rawTv == 'table' then
				emit('userdata:member:table', prefix .. '.' .. k)
			elseif rawTv == 'userdata' or rawTv == 'thread' then
				emit('userdata:member:object', prefix .. '.' .. k, fmtType(rawMember))
			else
				local pv = fmtPrimitiveValue(rawMember)
				if pv ~= nil then
					emit('userdata:member:value', prefix .. '.' .. k, rawTv .. '=' .. pv)
				else
					emit('userdata:member:value', prefix .. '.' .. k, rawTv)
				end
			end

			-- Also try reading the resolved member off the userdata itself.
			local okGet, resolved = pcall(function()
				-- This may go through userdata metamethods and return bound functions.
				return u[k]
			end)
			if okGet and resolved ~= nil then
				local resolvedTv = type(resolved)
				if resolvedTv == 'function' then
					emit('userdata:resolved:function', prefix .. '.' .. k)
				elseif resolvedTv == 'table' then
					emit('userdata:resolved:table', prefix .. '.' .. k)
				elseif resolvedTv == 'userdata' or resolvedTv == 'thread' then
					emit('userdata:resolved:object', prefix .. '.' .. k, fmtType(resolved))
				else
						local pv = fmtPrimitiveValue(resolved)
						if pv ~= nil then
							emit('userdata:resolved:value', prefix .. '.' .. k, resolvedTv .. '=' .. pv)
						else
							emit('userdata:resolved:value', prefix .. '.' .. k, resolvedTv)
						end
				end
			end
		end
		elseif idxType == 'function' then
			-- We can't enumerate keys, but we can probe likely ones.
			local candidates = {}
			local seen = {}
			local function addCandidate(k)
				if type(k) ~= 'string' then return end
				if seen[k] then return end
				seen[k] = true
				candidates[#candidates + 1] = k
			end

			-- Common API guesses + any non-metamethod functions we saw on the metatable.
			addCandidate('on')
			addCandidate('off')
			addCandidate('once')
			addCandidate('every')
			addCandidate('listeners')
			addCandidate('eventNames')
			for i = 1, #mtKeys do
				local k = mtKeys[i]
				if k ~= nil and string.sub(k, 1, 2) ~= '__' then
					addCandidate(k)
				end
			end
			table.sort(candidates)

			for i = 1, #candidates do
				local k = candidates[i]

				local okIdx, viaIdx = pcall(function()
					return idx(u, k)
				end)
				if okIdx and viaIdx ~= nil then
					emit('userdata:idx:resolved', prefix .. '.' .. k, fmtType(viaIdx))
				end

				local okGet, viaGet = pcall(function()
					return u[k]
				end)
				if okGet and viaGet ~= nil then
					emit('userdata:get:resolved', prefix .. '.' .. k, fmtType(viaGet))
				end
			end
	end
end

local G = getGlobals()
local ENV = getEnv()

local function resolveName(name)
	-- Prefer environment lookup (may trigger __index / lazy injection).
	local ok, value = pcall(function()
		if type(ENV) == 'table' then return ENV[name] end
		return nil
	end)
	if not ok then return nil end
	return value
end

print('slua-detect\tv2\tbegin')

-- Directly probe names that may be provided via metatable/__index rather than as raw keys.
do
	local PROBE_NAMES = { 'LLEvents', 'LLTimer', 'LLTimers' }
	for i = 1, #PROBE_NAMES do
		local name = PROBE_NAMES[i]
		local raw = rawget(G, name)
		local resolved = resolveName(name)
		local rawType = raw == nil and 'missing' or fmtType(raw)
		local resolvedType = resolved == nil and 'missing' or fmtType(resolved)
		emit('probe', name, 'raw=' .. rawType .. '\tresolved=' .. resolvedType)
	end
end

-- Some runtimes expose identifiers via non-table resolution. Probe via direct access.
do
	local okEvents, valueEvents = pcall(function()
		-- eslint-disable-next-line no-undef
		return LLEvents
	end)
	local okTimer, valueTimer = pcall(function()
		-- eslint-disable-next-line no-undef
		return LLTimer
	end)
	local okTimers, valueTimers = pcall(function()
		-- eslint-disable-next-line no-undef
		return LLTimers
	end)

	emit('probe-direct', 'LLEvents', (okEvents and valueEvents ~= nil) and fmtType(valueEvents) or 'missing')
	emit('probe-direct', 'LLTimer', (okTimer and valueTimer ~= nil) and fmtType(valueTimer) or 'missing')
	emit('probe-direct', 'LLTimers', (okTimers and valueTimers ~= nil) and fmtType(valueTimers) or 'missing')

	if okEvents and valueEvents ~= nil and type(valueEvents) == 'userdata' then
		scanUserdata('LLEvents', valueEvents)
	end
	if okTimers and valueTimers ~= nil and type(valueTimers) == 'userdata' then
		scanUserdata('LLTimers', valueTimers)
	end
end

local keys = rawkeys(G)
for i = 1, #keys do
	local k = keys[i]
	local v = rawget(G, k)
	local tv = type(v)

	if tv == 'function' then
		emit('global:function', k)
	elseif tv == 'table' then
		emit('global:module', k)
	elseif tv == 'userdata' or tv == 'thread' then
		emit('global:object', k, fmtType(v))
	else
		-- ignore primitives: nil/boolean/number/string
	end
end

print('slua-detect\tv2\tend')
