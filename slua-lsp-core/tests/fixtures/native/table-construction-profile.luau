local M = {}
local alias = M
alias.count = 42
M.nested = {}
M.nested.message = 'hi'
function M.double(value: number): number return value * 2 end
function M:message(value: string): string return self.nested.message .. value end
assert(M.count == 42 and M.double(3) == 6 and M:message('!') == 'hi!')
assert(M.message(M, '?') == 'hi?')
M['__proto__'] = 'ordinary-key'
assert(alias['__proto__'] == 'ordinary-key')
local forwarded
forwarded, M.other = M, 7
local previous = M
M, M.onPrevious = {}, 'old'
assert(previous == forwarded and forwarded.other == 7 and previous.onPrevious == 'old')
assert(M ~= previous and M.onPrevious == nil)
print('table-construction-ok', previous.count, previous.double(3), previous:message('!'))
