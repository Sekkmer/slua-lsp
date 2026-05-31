import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		pool: 'forks',
		isolate: true,
		testTimeout: 2_000
	}
});
