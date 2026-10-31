-- Safe local builder qualification. Never call apply or any host/world API.
local ParamSetter = llprim.ParamSetter
assert(type(ParamSetter) == "table")
local cases = {
 {"targetLink", {1}, 34, -1},
 {"physicsMaterial", {1}, 2, -1},
 {"physical", {true}, 3, -1},
 {"temporary", {true}, 4, -1},
 {"phantom", {true}, 5, -1},
 {"pos", {vector(1, 2, 3)}, 6, -1},
 {"size", {vector(1, 2, 3)}, 7, -1},
 {"rot", {quaternion.identity}, 8, -1},
 {"primTypeBox", {1, vector(1, 2, 3), 0.5, vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3)}, 9, 0},
 {"primTypeCylinder", {1, vector(1, 2, 3), 0.5, vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3)}, 9, 1},
 {"primTypePrism", {1, vector(1, 2, 3), 0.5, vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3)}, 9, 2},
 {"primTypeSphere", {1, vector(1, 2, 3), 0.5, vector(1, 2, 3), vector(1, 2, 3)}, 9, 3},
 {"primTypeTorus", {1, vector(1, 2, 3), 0.5, vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), 0.5, 0.5, 0.5}, 9, 4},
 {"primTypeTube", {1, vector(1, 2, 3), 0.5, vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), 0.5, 0.5, 0.5}, 9, 5},
 {"primTypeRing", {1, vector(1, 2, 3), 0.5, vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), vector(1, 2, 3), 0.5, 0.5, 0.5}, 9, 6},
 {"primTypeSculpt", {"asset", 1}, 9, 7},
 {"texture", {1, "asset", vector(1, 2, 3), vector(1, 2, 3), 0.5}, 17, -1},
 {"color", {1, vector(1, 2, 3), 0.5}, 18, -1},
 {"shinyBump", {1, 1, 1}, 19, -1},
 {"fullbright", {1, true}, 20, -1},
 {"flexible", {true, 1, 0.5, 0.5, 0.5, 0.5, vector(1, 2, 3)}, 21, -1},
 {"texgen", {1, 1}, 22, -1},
 {"pointLight", {true, vector(1, 2, 3), 0.5, 0.5, 0.5}, 23, -1},
 {"glow", {1, 0.5}, 25, -1},
 {"text", {"text", vector(1, 2, 3), 0.5}, 26, -1},
 {"name", {"text"}, 27, -1},
 {"description", {"text"}, 28, -1},
 {"rotLocal", {quaternion.identity}, 29, -1},
 {"physicsShapeType", {1}, 30, -1},
 {"omega", {vector(1, 2, 3), 0.5, 0.5}, 32, -1},
 {"posLocal", {vector(1, 2, 3)}, 33, -1},
 {"slice", {vector(1, 2, 3)}, 35, -1},
 {"specular", {1, "asset", vector(1, 2, 3), vector(1, 2, 3), 0.5, vector(1, 2, 3), 1, 1}, 36, -1},
 {"normal", {1, "asset", vector(1, 2, 3), vector(1, 2, 3), 0.5}, 37, -1},
 {"alphaMode", {1, 1, 1}, 38, -1},
 {"allowUnsit", {true}, 39, -1},
 {"scriptedSitOnly", {true}, 40, -1},
 {"sitTarget", {true, vector(1, 2, 3), quaternion.identity}, 41, -1},
 {"projector", {"text", 0.5, 0.5, 0.5}, 42, -1},
 {"clickAction", {1}, 43, -1},
 {"reflectionProbe", {true, 0.5, 0.5, 1}, 44, -1},
 {"gltfNormal", {1, "asset", vector(1, 2, 3), vector(1, 2, 3), 0.5}, 45, -1},
 {"gltfEmissive", {1, "asset", vector(1, 2, 3), vector(1, 2, 3), 0.5, vector(1, 2, 3)}, 46, -1},
 {"gltfMetallicRoughness", {1, "asset", vector(1, 2, 3), vector(1, 2, 3), 0.5, 0.5, 0.5}, 47, -1},
 {"gltfBaseColor", {1, "asset", vector(1, 2, 3), vector(1, 2, 3), 0.5, vector(1, 2, 3), 0.5, 1, 0.5, true}, 48, -1},
 {"renderMaterial", {1, "asset"}, 49, -1},
 {"sitFlags", {1}, 50, -1},
 {"damage", {0.5, 1}, 51, -1},
 {"health", {0.5}, 52, -1},
 {"collisionSound", {"asset", 0.5}, 53, -1},
}
for _, case in cases do
 local rules = ParamSetter.new()
 assert(rules[case[1]](rules, unpack(case[2])) == rules)
 local hasVariant = case[4] >= 0
 assert(#rules == #case[2] + 1 + (if hasVariant then 1 else 0))
 assert(rules[1] == case[3])
 if hasVariant then assert(rules[2] == case[4]) end
end
local rules = ParamSetter.new():size(vector(1, 2, 3)):name("local only")
assert(rules:extend({7, vector.one}) == rules)
local other = setmetatable({}, ParamSetter):physical(true)
assert(other[2] == 1)
local nullable = ParamSetter.new():gltfBaseColor(1, "", "", "", "", "", "", "", "", "")
assert(#nullable == 11)
assert(not pcall(function() ParamSetter.new():size("not a vector") end))
assert(not pcall(function() ParamSetter.new():name(42) end))
assert(not pcall(function() ParamSetter.new():gltfNormal(0, "asset", "nonempty", vector.one, 0) end))
assert(not pcall(function() ParamSetter.new():extend("not a table") end))
local names = {}
for name, value in ParamSetter do if name ~= "__index" then assert(type(value) == "function"); table.insert(names, name) end end
table.sort(names)
print(table.concat(names, ","))
