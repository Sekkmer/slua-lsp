import { describe, expect, it } from 'vitest';

import { SERVER_NAME } from '../src/constants.js';

describe('constants', () => {
	it('has a server name', () => {
		expect(SERVER_NAME).toBe('slua-lsp');
	});
});
