-- Local VM library freeze checks only; no host/world call is made.
local native = math
local original = native.pi
assert(table.isfrozen(native))
assert(not pcall(function() native.pi = 0 end))
assert(math.pi == original)
local math = {pi = 1}
math.pi = 2
local function change(math) math.pi = 3 end
change(math)
assert(math.pi == 3)
local callback = function(value) value.pi = 4 end
callback(math)
assert(math.pi == 4)
print("PASS local builtin module freeze, alias rejection and mutable shadows")
