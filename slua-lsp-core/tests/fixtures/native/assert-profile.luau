local first, second = assert(1, "message")
assert(first == 1 and second == "message")
local function requireNumber(value: number?)
    return assert(value)
end
assert(requireNumber(3) == 3)
print("PASS\tassert runtime retains arguments and returns the checked value")
