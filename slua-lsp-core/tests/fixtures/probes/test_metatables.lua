-- Test file for vector and rotation/quaternion metatable operations
-- This file tests the metamethods implementation for SLua types

print("=== Vector Operations Test ===")

-- Test vector creation
local v1 = vector(1, 2, 3)
local v2 = vector(4, 5, 6)
print("v1:", v1)
print("v2:", v2)

-- Test vector addition
local v_add = v1 + v2
print("v1 + v2:", v_add)

-- Test vector subtraction
local v_sub = v1 - v2
print("v1 - v2:", v_sub)

-- Test vector multiplication
local v_mul_scalar = v1 * 2
print("v1 * 2:", v_mul_scalar)

local v_mul_vector = v1 * v2
print("v1 * v2:", v_mul_vector)

-- Test scalar * vector
local scalar_mul_v = 3 * v1
print("3 * v1:", scalar_mul_v)

-- Test vector division
local v_div_scalar = v1 / 2
print("v1 / 2:", v_div_scalar)

local v_div_vector = v1 / v2
print("v1 / v2:", v_div_vector)

-- Test vector modulo
local v_mod = v1 % v2
print("v1 % v2:", v_mod)

-- Test vector negation
local v_neg = -v1
print("-v1:", v_neg)

-- Test vector equality
local v_eq = v1 == v2
print("v1 == v2:", v_eq)

-- Test vector access
print("v1.x:", v1.x)
print("v1.y:", v1.y)
print("v1.z:", v1.z)

-- Test vector typeof
print("typeof(v1):", typeof(v1))

print("\n=== Rotation Operations Test ===")

-- Test rotation creation
local r1 = rotation(0, 0, 0, 1)
local r2 = rotation(0.5, 0, 0, 0.866)
print("r1:", r1)
print("r2:", r2)

-- Test quaternion creation (alias)
local q1 = quaternion(0, 0, 0, 1)
print("q1:", q1)

-- Test rotation addition
local r_add = r1 + r2
print("r1 + r2:", r_add)

-- Test rotation subtraction
local r_sub = r1 - r2
print("r1 - r2:", r_sub)

-- Test rotation multiplication
local r_mul = r1 * r2
print("r1 * r2:", r_mul)

-- Test rotation * scalar
local r_mul_scalar = r1 * 2
print("r1 * 2:", r_mul_scalar)

-- Test scalar * rotation
local scalar_mul_r = 0.5 * r1
print("0.5 * r1:", scalar_mul_r)

-- Test rotation division
local r_div = r1 / r2
print("r1 / r2:", r_div)

local r_div_scalar = r1 / 2
print("r1 / 2:", r_div_scalar)

-- Test rotation negation
local r_neg = -r1
print("-r1:", r_neg)

-- Test rotation equality
local r_eq = r1 == r2
print("r1 == r2:", r_eq)

-- Test rotation access
print("r1.x:", r1.x)
print("r1.y:", r1.y)
print("r1.z:", r1.z)

-- Test rotation typeof
print("typeof(r1):", typeof(r1))
print("typeof(q1):", typeof(q1))

print("\n=== Vector * Rotation Test ===")

-- Test vector rotated by rotation
local v3 = vector(1, 0, 0)
local r_90z = rotation(0, 0, 0.7071, 0.7071) -- 90 degrees around Z
local v_rotated = v3 * r_90z
print("vector(1,0,0) * rotation_90z:", v_rotated)

-- Test rotation * vector
local v_rotated2 = r_90z * v3
print("rotation_90z * vector(1,0,0):", v_rotated2)

print("\n=== Module Functions Test ===")

-- Test vector module
local v_zero = vector.zero
local v_one = vector.one
print("vector.zero:", v_zero)
print("vector.one:", v_one)

local v_norm = vector.normalize(v1)
print("vector.normalize(v1):", v_norm)

local v_mag = vector.magnitude(v1)
print("vector.magnitude(v1):", v_mag)

-- Test rotation module
local r_identity = rotation.identity
print("rotation.identity:", r_identity)

local r_norm = rotation.normalize(r1)
print("rotation.normalize(r1):", r_norm)

-- Test quaternion module
local q_identity = quaternion.identity
print("quaternion.identity:", q_identity)

print("\n=== Type Checking Test ===")

-- Test type checking with typeof
local function checkType(value)
    local t = typeof(value)
    print("Type of", tostring(value), "is", t)
end

checkType(v1)
checkType(r1)
checkType(q1)
checkType(42)
checkType("hello")
checkType(true)

print("\n=== Metatable Test Complete ===")
