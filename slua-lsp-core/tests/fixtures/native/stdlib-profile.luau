-- Pure local standard-library checks; no host ll API, FS IPC, or world effect.
assert(string.sub("abc", 2) == "bc")
assert(string.char() == "" and string.char(65, 66) == "AB")
assert(string.unpack("B", "A") == 65)
assert(#string.split("a,b") == 2)
assert(tonumber("invalid") == nil and tonumber("ff", 16) == 255)
assert(math.min(3) == 3 and math.max(1, 3, 2) == 3)
assert(type(math.random()) == "number" and type(math.noise(1)) == "number")
local whole, fraction = math.modf(2.5)
assert(whole == 2 and fraction == 0.5)
assert(table.pack().n == 0)
local values = {1, 2, 3}
assert(table.remove(values) == 3)
assert(table.find(values, 9) == nil)
-- SLua's tagged 64-bit integer key is distinct from a numeric array index.
assert(values[1] == 1 and values[integer.create(1)] == nil)
local hashKeys = {[false] = "boolean", ["1"] = "string"}
assert(hashKeys[false] == "boolean" and hashKeys["1"] == "string")
table.move(values, 1, 2, 1)
table.sort(values)
assert(table.concat(values, ",") == "1,2")
assert(#table.create(3) == 0)
assert(utf8.char() == "" and utf8.char(65, 66) == "AB")
assert(utf8.len("abc") == 3 and utf8.codepoint("a") == 97)
assert(utf8.offset("abc", 1) == 1)
local b = buffer.create(16)
buffer.writei8(b, 0, 65)
buffer.writebits(b, 8, 8, 66)
buffer.fill(b, 2, 67)
buffer.writestring(b, 4, "D")
buffer.copy(b, 8, b, 0, 4)
assert(buffer.readi8(b, 0) == 65 and buffer.readbits(b, 8, 8) == 66)
assert(buffer.readstring(b, 8, 4) == "ABCC")
assert(bit32.band() == 4294967295 and bit32.bor(1) == 1)
assert(bit32.extract(3, 0) == 1 and bit32.replace(0, 1, 0) == 1)
-- SLua additions independently exercised; generic strict analyzer does not
-- declare table.append/extend or every profile feature.
local list = {}
table.append(list, 1, 2)
assert(table.extend(list, {3, 4}) == list and #list == 4)
assert(math.e > 2 and math.phi > 1 and math.sqrt2 > 1 and math.tau > 6)
assert(math.nan ~= math.nan)
local long = integer.maxsigned
buffer.writeinteger(b, 0, long)
assert(buffer.readinteger(b, 0) == long)
assert(select("#", coroutine.running()) == 1)
local finalized = false
local co = coroutine.create(function(value)
 assert(coroutine.running() ~= nil)
 return value
end)
coroutine.finally(co, function(status, value) finalized = status == "finished" and value == 42 end)
local ok, value = coroutine.resume(co, 42)
assert(ok and value == 42 and finalized)
assert(coroutine.close(co))
assert(bit32.btest())
local result = {}
for name, module in {string=string, table=table, math=math, os=os, utf8=utf8, buffer=buffer, debug=debug, coroutine=coroutine, bit32=bit32} do
 local members = {}
 for key, value in module do members[key] = type(value) end
 result[name] = members
end
print(lljson.encode(result))
