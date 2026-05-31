import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		pool: 'forks',
		isolate: true,
		slowTestThreshold: 1_000,
		testTimeout: 2_000,
		hookTimeout: 10_000,
		teardownTimeout: 10_000
	}
});
