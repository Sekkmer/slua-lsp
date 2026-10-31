-- Test file for go-to-definition feature

-- Local variable definition
local myVariable = 42
local result = myVariable * 2  -- Ctrl+click on 'myVariable' should jump to line 4

-- Function definition
local function calculateSum(a, b, c)
	local temp = a + b  -- Ctrl+click on 'a' or 'b' should jump to parameters on line 8
	return temp + c     -- Ctrl+click on 'temp' should jump to line 9
end

local answer = calculateSum(1, 2, 3)  -- Ctrl+click on 'calculateSum' should jump to line 8

-- Nested scopes with shadowing
local x = 10
if true then
	local x = 20  -- Different 'x' than line 16
	local y = x   -- This 'x' refers to line 18, not line 16
end
local z = x  -- This 'x' refers to line 16, not line 18

-- Anonymous function
local multiply = function(num)
	return num * 2  -- Ctrl+click on 'num' should jump to parameter on line 24
end

-- Nested functions
local function outer()
	local outerVar = 100
	local function inner()
		local innerVar = outerVar + 1  -- Should jump to line 30
		return innerVar
	end
	return inner()
end
