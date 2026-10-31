-- Touch-only DetectedEvent probe
--
-- Goal: When a touch event fires, dump as much information as possible about the
-- DetectedEvent userdata instances provided by the SLua runtime.
--
-- Expected callback shape (runtime-probed):
--   LLEvents:once("touch_start", function(detectedTable, extra, ...) end)
-- where detectedTable is an array-like table of DetectedEvent userdata.

local function safe_tostring(v)
	local ok, s = pcall(tostring, v)
	if ok then return s end
	return "<tostring error>"
end

local function pack(...)
	return { n = select("#", ...), ... }
end

local function indent(n)
	return string.rep(" ", n)
end

local function dump_table(t, depth, seen, ind)
	depth = depth or 2
	seen = seen or {}
	ind = ind or 0
	if type(t) ~= "table" then
		return "(" .. type(t) .. ") " .. safe_tostring(t)
	end
	if seen[t] then return "<cycle>" end
	seen[t] = true
	if depth <= 0 then return "{...}" end

	local out = {}
	local count = 0
	for k, v in pairs(t) do
		count += 1
		if count > 80 then
			out[#out + 1] = indent(ind + 2) .. "<...more keys...>"
			break
		end
		out[#out + 1] = indent(ind + 2)
			.. "[" .. type(k) .. "] " .. safe_tostring(k)
			.. " => (" .. type(v) .. ") "
			.. (type(v) == "table" and dump_table(v, depth - 1, seen, ind + 2) or safe_tostring(v))
	end
	return "{\n" .. table.concat(out, "\n") .. "\n" .. indent(ind) .. "}"
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

local function try_call0(obj, key)
	local okFn, fnOrErr = pcall(function()
		return (obj :: any)[key]
	end)
	if not okFn then
		return false, nil, safe_tostring(fnOrErr)
	end
	if type(fnOrErr) ~= "function" then
		return false, nil, "<not a function>"
	end

	-- Capture multiple returns (best effort up to 6 values).
	local ok, r1, r2, r3, r4, r5, r6 = pcall(fnOrErr, obj)
	if not ok then
		return false, nil, safe_tostring(r1)
	end
	return true, pack(r1, r2, r3, r4, r5, r6), nil
end

local function describe_returns(p)
	if type(p) ~= "table" then return "<not packed>" end
	local parts = {}
	for i = 1, (p.n or 0) do
		local v = p[i]
		parts[#parts + 1] = "#" .. tostring(i) .. " (" .. type(v) .. ") " .. safe_tostring(v)
	end
	if (p.n or 0) == 0 then
		return "(no returns)"
	end
	return table.concat(parts, "; ")
end

local function probe_candidate_keys(u, keys)
	local hits = 0
	for _, key in ipairs(keys) do
		local ok, v, err = try_get(u, key)
		if ok then
			hits += 1
			if type(v) == "function" then
				local okCall, ret, callErr = try_call0(u, key)
				if okCall then
					print("    hit ." .. key .. " => (function) " .. safe_tostring(v) .. " ; call(self) => " .. describe_returns(ret))
				else
					print("    hit ." .. key .. " => (function) " .. safe_tostring(v) .. " ; call(self) => <error> " .. safe_tostring(callErr))
				end
			else
				print("    hit ." .. key .. " => (" .. type(v) .. ") " .. safe_tostring(v))
			end
		elseif err and err ~= "" then
			-- Suppress noisy unknown-key errors; keep ones that look informative.
			local lower = string.lower(err)
			if string.find(lower, "supported") or string.find(lower, "valid") or string.find(lower, "expected") or string.find(lower, "unknown") then
				-- too noisy, skip
			else
				-- occasionally errors include type info / hints
				-- print("    miss ." .. key .. " => <error> " .. safe_tostring(err))
			end
		end
	end
	print("    candidate key hits: " .. tostring(hits) .. "/" .. tostring(#keys))
end

local function build_candidate_keys()
	local base = {
		-- Common identity-ish
		"key",
		"id",
		"uuid",
		"name",
		"owner",
		"group",
		"type",
		"link",
		"linkNum",
		"linkNumber",
		"prim",
		"primNum",
		"primNumber",
		-- Common spatial-ish
		"pos",
		"position",
		"localPos",
		"localPosition",
		"rot",
		"rotation",
		"localRot",
		"localRotation",
		"vel",
		"velocity",
		"accel",
		"acceleration",
		"angVel",
		"angularVelocity",
		-- Touch/collision-specific
		"touchPos",
		"touchPosition",
		"touchNormal",
		"touchBinormal",
		"touchST",
		"touchUV",
		"touchFace",
		"touchSurface",
		"normal",
		"binormal",
		"tangent",
		"face",
		"surface",
		-- LSL llDetected* name fragments
		"DetectedKey",
		"DetectedName",
		"DetectedOwner",
		"DetectedGroup",
		"DetectedType",
		"DetectedLinkNumber",
		"DetectedPos",
		"DetectedRot",
		"DetectedVel",
		"DetectedGrab",
		"DetectedTouchBinormal",
		"DetectedTouchFace",
		"DetectedTouchNormal",
		"DetectedTouchPos",
		"DetectedTouchST",
		"DetectedTouchUV"
	}

	local out = {}
	local seen = {}
	local function add(s)
		if not s or s == "" then return end
		if seen[s] then return end
		seen[s] = true
		out[#out + 1] = s
	end

	local function ucfirst(s)
		return string.upper(string.sub(s, 1, 1)) .. string.sub(s, 2)
	end

	local function snake_from_camel(s)
		-- Best effort camelCase -> snake_case
		local buf = {}
		for i = 1, #s do
			local ch = string.sub(s, i, i)
			local isUpper = ch >= 'A' and ch <= 'Z'
			if isUpper and i > 1 then
				buf[#buf + 1] = "_" .. string.lower(ch)
			else
				buf[#buf + 1] = string.lower(ch)
			end
		end
		return table.concat(buf, "")
	end

	for _, s in ipairs(base) do
		add(s)
		add(string.lower(s))
		add(ucfirst(string.lower(s)))
		add(snake_from_camel(s))
		add("get" .. ucfirst(s))
		add("Get" .. ucfirst(s))
		add("is" .. ucfirst(s))
		add("Is" .. ucfirst(s))
		add("has" .. ucfirst(s))
		add("Has" .. ucfirst(s))
	end

	-- Also probe some common metamethod-ish names that sometimes exist as fields
	for _, s in ipairs({ "__type", "__name", "__tostring" }) do
		add(s)
	end

	return out
end

local CANDIDATE_KEYS = build_candidate_keys()

-- Keep output manageable by default.
local MAX_DETECTED_TO_INSPECT = 1

-- Known/likely methods based on LSL llDetected* family and common SLua naming.
-- These are the highest-signal probes to confirm the true surface area.
local LIKELY_DETECTED_METHODS = {
	"getKey",
	"getName",
	"getOwner",
	"getGroup",
	"getType",
	"getLinkNumber",
	"getPos",
	"getRot",
	"getVel",
	"getGrab",
	"getTouchBinormal",
	"getTouchFace",
	"getTouchNormal",
	"getTouchPos",
	"getTouchST",
	"getTouchUV"
}

local function inspect_userdata(u)
	print("  typeof=" .. (typeof and typeof(u) or type(u)) .. " type=" .. type(u) .. " tostring=" .. safe_tostring(u))

	-- Common fields observed in runtime probe stringification
	for _, key in ipairs({ "index", "valid", "canAdjustDamage" }) do
		local ok, v, err = try_get(u, key)
		if ok then
			print("    field ." .. key .. " => (" .. type(v) .. ") " .. safe_tostring(v))
		else
			print("    field ." .. key .. " => <error> " .. safe_tostring(err))
		end
	end

	-- Metatable introspection
	local okMt, mt = pcall(getmetatable, u)
	if not okMt then
		print("    getmetatable => <error> " .. safe_tostring(mt))
		return
	end
	print("    metatable => (" .. type(mt) .. ") " .. safe_tostring(mt))
	if type(mt) == "table" then
		for _, k in ipairs({ "__name", "__type", "__tostring", "__index", "__pairs", "__ipairs" }) do
			local v = mt[k]
			print("      mt[" .. k .. "] => (" .. type(v) .. ") " .. safe_tostring(v))
		end

		local idx = mt.__index
		if type(idx) == "table" then
			print("    __index keys:")
			local keys = {}
			for k, v in pairs(idx) do
				keys[#keys + 1] = { k = k, v = v }
			end
			table.sort(keys, function(a, b)
				return safe_tostring(a.k) < safe_tostring(b.k)
			end)
			for _, kv in ipairs(keys) do
				print("      " .. safe_tostring(kv.k) .. " => (" .. type(kv.v) .. ")")
			end

			-- Try calling no-arg instance methods (best effort)
			print("    probing __index methods (self-only):")
			for _, kv in ipairs(keys) do
				if type(kv.k) == "string" and type(kv.v) == "function" then
					local ok, ret, err = try_call0(u, kv.k)
					if ok then
						print("      " .. kv.k .. "() => (" .. type(ret) .. ") " .. safe_tostring(ret))
					else
						print("      " .. kv.k .. "() => <error> " .. safe_tostring(err))
					end
				end
			end
		elseif type(idx) == "function" then
			print("    __index is a function; attempting hint extraction")
			local okBad, bad = pcall(function()
				-- Calling __index directly is sometimes allowed and may return helpful errors.
				-- We intentionally use a key that is unlikely to exist.
				return (idx :: any)(u, "__probe_invalid_key__")
			end)
			if okBad then
				print("      __index(u, invalid) returned: (" .. type(bad) .. ") " .. safe_tostring(bad))
			else
				print("      __index(u, invalid) errored: " .. safe_tostring(bad))
			end
			print("    probing likely DetectedEvent methods:")
			probe_candidate_keys(u, LIKELY_DETECTED_METHODS)
			print("    probing candidate keys (properties + self methods):")
			probe_candidate_keys(u, CANDIDATE_KEYS)
		end
	end

	-- pairs/ipairs on userdata (if supported)
	local okPairs, it = pcall(function()
		local out = {}
		local count = 0
		for k, v in pairs(u :: any) do
			count += 1
			out[#out + 1] = "      [" .. type(k) .. "] " .. safe_tostring(k) .. " => (" .. type(v) .. ") " .. safe_tostring(v)
			if count > 40 then
				out[#out + 1] = "      <...more...>"
				break
			end
		end
		return out
	end)
	if okPairs and type(it) == "table" then
		print("    pairs(u) succeeded:")
		for _, line in ipairs(it) do
			print(line)
		end
	else
		print("    pairs(u) failed: " .. safe_tostring(it))
	end
end

local function on_touch_event(eventName, detected, extra, ...)
	print("=== TOUCH EVENT " .. eventName .. " ===")
	local packed = pack(detected, extra, ...)
	print("received args: " .. packed.n)
	if extra ~= nil then
		print("!! extra sentinel is non-nil: " .. safe_tostring(extra))
	end
	if select("#", ...) > 0 then
		print("!! extra varargs present: #=" .. tostring(select("#", ...)))
	end

	print("detected type=" .. type(detected) .. " tostring=" .. safe_tostring(detected))
	if type(detected) == "table" then
		print("detected table shape:\n" .. dump_table(detected, 2, {}, 0))
		local n = #detected
		print("detected #=" .. tostring(n))
		for i, ev in ipairs(detected) do
			if i > MAX_DETECTED_TO_INSPECT then
				if n > MAX_DETECTED_TO_INSPECT then
					print("(skipping remaining detected entries; MAX_DETECTED_TO_INSPECT=" .. tostring(MAX_DETECTED_TO_INSPECT) .. ")")
				end
				break
			end
			print("- detected[" .. tostring(i) .. "]:")
			inspect_userdata(ev)
		end
	else
		print("detected is not a table; inspecting as-is")
		inspect_userdata(detected)
	end
end

local function safe_register(name)
	local ok, err = pcall(function()
		LLEvents:once(name, function(detected, extra, ...)
			on_touch_event(name, detected, extra, ...)
		end)
	end)
	if not ok then
		print("failed to register " .. name .. ": " .. safe_tostring(err))
	end
end

safe_register("touch_start")
safe_register("touch")
safe_register("touch_end")

print("(llevents_probe_touch_detected_event) registered once handlers for touch_start/touch/touch_end")
