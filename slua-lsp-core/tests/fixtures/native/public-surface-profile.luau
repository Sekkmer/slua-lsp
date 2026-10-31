-- Safe local raw-export inventory and internal timer dispatch only; no host function invocation.
local result = {constants = {}, functions = {}}
for _, name in {"FALSE", "GCNP_GET_WALKABILITY", "LEGACY_MASS_FACTOR", "NAVIGATE_TO_GOAL_REACHED_DIST", "PARCEL_FLAG_LINDEN_HOMES", "PRIM_MATERIAL_DENSITY", "PRIM_MATERIAL_FRICTION", "PRIM_MATERIAL_GRAVITY_MULTIPLIER", "PRIM_MATERIAL_RESTITUTION", "PSYS_SRC_OBJ_REL_MASK", "REZ_TORQUE", "SKY_ABSORPTION_CONFIG", "SKY_DENSITY_PROFILE_COUNTS", "SKY_MIE_CONFIG", "SKY_RAYLEIGH_CONFIG", "TRUE"} do result.constants[name] = {global = type(rawget(getfenv(), name)), ll = type(rawget(ll, name)), llcompat = type(rawget(llcompat, name))} end
for _, name in {"ClearExperience", "ClearExperiencePermissions", "GetAndResetTime", "GetExperienceList", "PointAt", "RemoteLoadScript", "ResetTime", "SetExperienceKey", "SetMemoryLimit", "SetTimerEvent", "StopPointAt"} do result.functions[name] = {ll = type(rawget(ll, name)), llcompat = type(rawget(llcompat, name))} end
local n = 0
local handler = LLEvents:on("timer", function() n += 1 end)
LLEvents:_handleEvent("timer")
assert(n == 1)
assert(LLEvents:off("timer", handler))
result.timer = {calls = n, handlersAfter = #LLEvents:handlers("timer")}
print(lljson.encode(result))
