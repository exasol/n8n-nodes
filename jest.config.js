/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	testMatch: ['**/tests/**/*.test.ts', '**/tests/**/*.itest.ts'],
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
	},
	modulePathIgnorePatterns: ['<rootDir>/dist/'],
	collectCoverage: true,
	coverageDirectory: 'coverage',
	coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
};
