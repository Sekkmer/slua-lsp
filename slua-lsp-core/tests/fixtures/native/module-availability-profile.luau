-- Local binding behavior and raw export inspection only. Never call a host API.
local modules = {ll = ll, llcompat = llcompat}
local exports = {}
for name, module in modules do
 local selected = {}
 for _, key in {"SetTimerEvent", "SetMemoryLimit", "ResetTime", "GetAndResetTime"} do
  selected[key] = type(rawget(module, key))
 end
 exports[name] = selected
end
local called = 0
local ll = {ResetTime = function() called += 1 end}
ll.ResetTime()
local function shadow(ll) ll.SetTimerEvent(1) end
shadow({SetTimerEvent = function(value) called += value end})
local function timer() called += 1 end
timer()
assert(called == 3)
print(lljson.encode(exports))
