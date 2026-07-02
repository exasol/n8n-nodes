/** @type {import('jest').Config} */

// Shared by both projects — avoids duplicating the ts-jest transform config.
const tsJestTransform = {
	'^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
};

module.exports = {
	projects: [
		{
			displayName: 'unit',
			testEnvironment: 'node',
			testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
			transform: tsJestTransform,
			modulePathIgnorePatterns: ['<rootDir>/dist/'],
			collectCoverage: true,
			coverageDirectory: 'coverage',
			coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '/tests/integration/'],
		},
		{
			displayName: 'itest',
			testEnvironment: 'node',
			testMatch: ['<rootDir>/tests/integration/**/*.itest.ts'],
			transform: tsJestTransform,
			modulePathIgnorePatterns: ['<rootDir>/dist/'],
			// Container startup takes ~2 minutes; give each test suite enough headroom.
			testTimeout: 300_000,
			// Run suites sequentially so only one worker calls startExasolContainer().
			// Multiple parallel workers would each spin up their own exasol/docker-db
			// (~3-4 GB each), which OOMs the CI runner.
			maxWorkers: 1,
			// PR2 ships no *.itest.ts files yet; pass rather than error on empty match.
			passWithNoTests: true,
		},
	],
};
