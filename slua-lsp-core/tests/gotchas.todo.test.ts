import { describe, it } from 'vitest';

describe('gotcha rules (TDD outline)', () => {
	it.todo('warn on accidental global writes (missing local)');
	it.todo('warn on table iteration gotchas (pairs/ipairs/non-array)');
	it.todo('warn on truthiness footguns (0/"" differences vs other langs)');
	it.todo('warn on metamethod surprises (==, __index, __newindex)');
	it.todo('warn on implicit nil returns where a value is expected');
	it.todo('warn on Luau-specific quirks we decide to enforce');
});
