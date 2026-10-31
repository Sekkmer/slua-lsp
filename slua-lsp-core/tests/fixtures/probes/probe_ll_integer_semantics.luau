-- Probe integer-ish semantics in ll / llcompat.
-- Intended to be run inside the SLua VM.

local function show(label: string, ...)
	print(label, ...)
end

local function try(label: string, fn)
	local ok, a, b, c, d = pcall(fn)
	if ok then
		show(label .. " => ok", a, b, c, d)
	else
		show(label .. " => err", a)
	end
end

show("typeof(integer)", typeof(integer))
if type(integer) == 'function' then
	try("integer(1)", function() return integer(1), typeof(integer(1)) end)
	try("integer(1.2)", function() return integer(1.2), typeof(integer(1.2)) end)
end

show("typeof(ll)", typeof(ll))
show("typeof(llcompat)", typeof(llcompat))

if type(ll) == 'table' then
	try("ll.Abs(-3)", function() return ll.Abs(-3), typeof(ll.Abs(-3)) end)
	try("ll.Abs(-3.7)", function() return ll.Abs(-3.7), typeof(ll.Abs(-3.7)) end)
	try("ll.Floor(1.9)", function() return ll.Floor(1.9), typeof(ll.Floor(1.9)) end)
	try("ll.Ceil(1.1)", function() return ll.Ceil(1.1), typeof(ll.Ceil(1.1)) end)

	try("ll.GetListLength({1,2,3})", function() return ll.GetListLength({ 1, 2, 3 }), typeof(ll.GetListLength({ 1, 2, 3 })) end)

	try("ll.List2Integer({1,2,3}, 2)", function() return ll.List2Integer({ 1, 2, 3 }, 2) end)
	try("ll.List2Integer({1,2,3}, 2.1)", function() return ll.List2Integer({ 1, 2, 3 }, 2.1) end)
end

if type(llcompat) == 'table' then
	try("llcompat.List2Integer({1,2,3}, 1)", function() return llcompat.List2Integer({ 1, 2, 3 }, 1) end)
	try("llcompat.List2Integer({1,2,3}, 0)", function() return llcompat.List2Integer({ 1, 2, 3 }, 0) end)
	try("llcompat.List2Integer({1,2,3}, -1)", function() return llcompat.List2Integer({ 1, 2, 3 }, -1) end)
end
