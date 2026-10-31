-- Pure local language semantics: no simulator API or filesystem IPC.
const value = 2
const function sum(n: number): number
    if n == 0 then return 0 end
    return n + sum(n - 1)
end
const values = {count = value}
values.count += 1
values["extra"] = 4
assert(value == 2 and values.count == 3 and values.extra == 4 and sum(3) == 6)
do
    local value = 5
    value += 1
    assert(value == 6)
end
assert(value == 2)
const a, b = string.byte("ab", 1, 2)
assert(a == 97 and b == 98)
local function pair(): (number, string) return 1, "two" end
local first, second = (pair())
assert(first == 1 and second == nil)
print("const-bindings-ok", value, values.count, sum(3))
