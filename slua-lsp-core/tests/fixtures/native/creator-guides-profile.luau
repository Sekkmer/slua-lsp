-- Pinned Creator-guide reconciliation. Pure local --sl VM; no host ll calls.
-- These assertions intentionally differ from several guide examples.
assert(lljson.encode({}) == "[]")
assert(lljson.encode(lljson.empty_array) == "[]")
assert(lljson.encode(lljson.empty_object) == "{}")
assert(lljson.encode(setmetatable({}, lljson.array_mt)) == "[]")
assert(lljson.encode(setmetatable({}, lljson.object_mt)) == "{}")
assert(lljson.encode({[1] = "first", [4] = "fourth"}) == '["first",null,null,"fourth"]')
local sparseOk, sparseError = pcall(lljson.encode, {[1] = "first", [1000] = "last"})
assert(not sparseOk and string.find(sparseError, "excessively sparse array", 1, true))
local mixed = lljson.decode(lljson.encode({[1] = "one", name = "test"}))
assert(mixed["1"] == "one" and mixed.name == "test")
assert(lljson.encode(0 / 0) == "null")
assert(lljson.encode(math.huge) == "1e9999")
assert(lljson.encode(-math.huge) == "-1e9999")
assert(lljson.decode("1e9999") == math.huge)
assert(lljson.encode(uuid("12345678-1234-1234-1234-123456789abc")) == '"12345678-1234-1234-1234-123456789abc"')
assert(lljson.encode(vector(1, 2.5, 3.14286)) == '"<1,2.5,3.14286>"')
assert(lljson.encode(buffer.fromstring("Hello")) == '"SGVsbG8="')
local customized = setmetatable({x = 1}, {__tojson = function(self) return {value = self.x} end})
assert(lljson.encode(customized) == '{"value":1}')
assert(lljson.encode(customized, {skip_tojson = true}) == '{"x":1}')
assert(lljson.decode('{"value":null}').value == lljson.null)
assert(lljson.encode({missing = nil, nullable = lljson.null}) == '{"nullable":null}')
assert(not pcall(lljson.encode, {callback = function() end}))
assert(not pcall(lljson.decode, "{invalid}"))

-- Forward declarations and initializer scope: do not copy the guide's
-- unbound activeHandler/countdown references into supposedly repaired code.
local first, second
first = function() return second() end
second = function() return "forward-declared" end
assert(first() == "forward-declared")
local countdown
countdown = function() return countdown end
assert(countdown() == countdown)

local seen = {}
local removed, added
local original = LLEvents:on("listen", function()
    table.insert(seen, "original")
    LLEvents:off("listen", removed)
    if not added then
        added = LLEvents:on("listen", function() table.insert(seen, "added") end)
    end
end)
removed = LLEvents:on("listen", function() table.insert(seen, "removed") end)
LLEvents:_handleEvent("listen", 0, "owned local", uuid.null, "no host")
assert(table.concat(seen, ",") == "original")
LLEvents:_handleEvent("listen", 0, "owned local", uuid.null, "no host")
assert(table.concat(seen, ",") == "original,original,added")
assert(LLEvents:off("listen", original) and LLEvents:off("listen", added))

-- Cleanup keys must be the registered event names, not arbitrary labels.
local handlers = {
    touch_start = LLEvents:on("touch_start", function() end),
    listen = LLEvents:on("listen", function() end),
}
for event, handler in handlers do assert(LLEvents:off(event, handler)) end
assert(#LLEvents:handlers("touch_start") == 0 and #LLEvents:handlers("listen") == 0)
print("PASS\tCreator guide JSON, event mutation, lexical scope and cleanup corrections")
