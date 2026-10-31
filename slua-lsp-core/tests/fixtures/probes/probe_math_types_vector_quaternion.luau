-- Probe SLua math userdata behaviour for vector/rotation/quaternion.
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

local v = vector(1, 2, 3)
local v2 = vector(4, 5, 6)
local q = quaternion(0, 0, 0, 1)
local r = rotation(0, 0, 0, 1)

show("typeof(v)", typeof(v))
show("tostring(v)", tostring(v))
show("v.x/y/z", v.x, v.y, v.z)
try("v.w", function() return v.w end)
try("v.badField", function() return v.nope end)

show("typeof(q)", typeof(q))
show("typeof(r)", typeof(r))
show("tostring(q)", tostring(q))
show("q.x/y/z/s", q.x, q.y, q.z, q.s)
try("q.w", function() return q.w end)

-- Operators
try("v * v2 (dot?)", function() return v * v2 end)
try("v % v2 (cross)", function() return v % v2 end)
try("v / 2", function() return v / 2 end)
try("v * 2", function() return v * 2 end)
try("2 * v", function() return 2 * v end)

-- Rotation interactions
try("v * q (rotate)", function() return v * q end)
try("v / q (inverse rotate)", function() return v / q end)
try("q * q", function() return q * q end)
try("q / q", function() return q / q end)
try("-q", function() return -q end)

-- Known quirk: depending on runtime, q*v may error (quaternion __mul expects quaternion rhs).
try("q * v", function() return q * v end)

-- Module functions vs instance members
try("vector.abs(v)", function() return vector.abs(v) end)
try("v.abs", function() return v.abs end)
try("v:abs()", function() return v:abs() end)

try("quaternion.normalize(q)", function() return quaternion.normalize(q) end)
try("q.normalize", function() return q.normalize end)
try("q:normalize()", function() return q:normalize() end)
