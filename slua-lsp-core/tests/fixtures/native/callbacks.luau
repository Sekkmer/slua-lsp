-- Safe local --sl VM only. Internal dispatch never contacts a viewer/region.
local events, timers = LLEvents, LLTimers
local explicitCalls = 0
local explicitHandler = events.on(LLEvents, "listen", function() explicitCalls += 1 end)
LLEvents:_handleEvent("listen", 1, "explicit self", uuid.null, "local")
assert(explicitCalls == 1 and events.off(LLEvents, "listen", explicitHandler))
local explicitTimer = timers.once(LLTimers, 0, function() explicitCalls += 1 end)
LLTimers:_tick()
assert(explicitCalls == 2 and not timers.off(LLTimers, explicitTimer))
assert(not pcall(function() events.on("listen", function() end) end))
assert(not pcall(function() timers.once(0, function() end) end))
local rawRules = {}
local builder = llprim.ParamSetter.new()
assert(builder.size(rawRules, vector.one) == rawRules and #rawRules == 2)
local repeated = 0
local recurring = LLTimers:every(0, function(scheduled_time, interval)
    assert(type(scheduled_time) == "number")
    assert(interval == 0)
    repeated += 1
    return "ignored result"
end)
LLTimers:_tick()
assert(repeated == 1)
assert(LLTimers:off(recurring))
assert(not LLTimers:off(recurring))
local onceCount = 0
local once = LLTimers:once(0, function(scheduled_time, interval)
    assert(type(scheduled_time) == "number")
    assert(interval == nil)
    onceCount += 1
end)
LLTimers:_tick()
LLTimers:_tick()
assert(onceCount == 1)
assert(not LLTimers:off(once))
local counter = setmetatable({ count = 0 }, {
    __call = function(self, scheduled_time, interval)
        assert(type(scheduled_time) == "number" and interval == 0)
        self.count += 1
    end
})
assert(LLTimers:every(0, counter) == counter)
LLTimers:_tick()
assert(counter.count == 1)
assert(LLTimers:off(counter))
local calls = 0
local ignored = LLEvents:on("listen", function() calls += 1 end)
local extra = LLEvents:on("listen", function(channel, name, id, text, missing)
    assert(channel == 3 and name == "example" and text == "local")
    assert(missing == nil)
    calls += 1
end)
local callable = setmetatable({}, { __call = function(self, channel) assert(channel == 3); calls += 1 end })
assert(LLEvents:on("listen", callable) == callable)
LLEvents:_handleEvent("listen", 3, "example", uuid.create("00000000-0000-0000-0000-000000000000"), "local")
assert(calls == 3)
assert(LLEvents:off("listen", ignored))
assert(LLEvents:off("listen", extra))
assert(LLEvents:off("listen", callable))
local saved
for _, event in {"touch_start", "touch", "touch_end", "collision_start", "collision", "collision_end", "sensor", "on_damage", "final_damage"} do
    local token = LLEvents:on(event, function(detected)
        assert(#detected == 2 and table.isfrozen(detected))
        saved = detected[1]
        assert(typeof(saved) == "DetectedEvent")
        assert(saved.index == 1 and saved.valid == true)
        assert(saved.canAdjustDamage == (event == "on_damage"))
        -- Reading method handles is local; getters/adjustDamage are never called.
        for _, name in {"adjustDamage", "getDamage", "getGrab", "getGroup", "getKey", "getLinkNumber", "getName", "getOwner", "getPos", "getRezzer", "getRot", "getTouchBinormal", "getTouchFace", "getTouchNormal", "getTouchPos", "getTouchST", "getTouchUV", "getType", "getVel"} do
            assert(type(saved[name]) == "function")
        end
    end)
    LLEvents:_handleEvent(event, 2)
    assert(saved.valid == false and saved.index == 1)
    -- Inspect read-only rejection after the synthetic dispatcher unwinds.
    -- Nested caught write failures inside _handleEvent exposed a CLI yield-state
    -- failure; that distinct investigation is retained rather than hidden.
    assert(not pcall(function() saved.valid = false end))
    assert(not pcall(function() saved.index = 4 end))
    assert(not pcall(function() saved.canAdjustDamage = true end))
    assert(LLEvents:off(event, token))
end
-- This CLI has no host timer scheduling callback; its internal wrapper can
-- remain registered. User event registrations have all been removed.
for _, name in LLEvents:eventNames() do assert(name == "timer") end
print("PASS\ttimer callback args/tokens, callable tables, event argument omission/padding, nine detected-event lifecycles")
