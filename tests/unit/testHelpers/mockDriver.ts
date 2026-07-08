import { ExasolDriver } from '@exasol/exasol-driver-ts';

// jest.mock is hoisted to the top of this module by ts-jest's babel-free hoisting pass, so it
// takes effect before ExasolDriver is imported anywhere in a test file that imports this helper.
// Jest keeps a separate module registry per test file, so this mock only applies within the
// test file(s) that import setupMockDriver — it does not leak into other suites.
jest.mock('@exasol/exasol-driver-ts');

const MockedExasolDriver = jest.mocked(ExasolDriver);

export type MockStatement = {
	execute: jest.Mock;
	close: jest.Mock;
};

export type MockDriver = {
	connect: jest.Mock;
	close: jest.Mock;
	query: jest.Mock;
	prepare: jest.Mock;
};

/**
 * Builds the SQLResponse<SQLQueriesResponse> shape returned by stmt.execute() for a
 * rowCount-typed result (INSERT/UPDATE/DELETE have no result set to return).
 *
 * @param rowCount - number of rows the mocked statement reports as affected
 * @returns a minimal "ok" response carrying that rowCount
 */
export function rowCountResult(rowCount: number) {
	return {
		status: 'ok',
		responseData: {
			numResults: 1,
			results: [{ resultType: 'rowCount', rowCount }],
		},
	};
}

/**
 * Creates a mock prepared statement and driver, and wires ExasolDriver's mocked constructor
 * (via jest.mock above) to return that driver. Call this from a beforeEach so every test starts
 * with a fresh mock; the driver defaults to a 0-row rowCountResult until a test overrides it.
 *
 * @returns mockDriver — the driver instance returned by `new ExasolDriver(...)` in node code
 * @returns mockStatement — the statement instance returned by mockDriver.prepare(...)
 */
export function setupMockDriver(): { mockDriver: MockDriver; mockStatement: MockStatement } {
	const mockStatement: MockStatement = {
		execute: jest.fn().mockResolvedValue(rowCountResult(0)),
		close: jest.fn().mockResolvedValue(undefined),
	};
	const mockDriver: MockDriver = {
		connect: jest.fn().mockResolvedValue(undefined),
		close: jest.fn().mockResolvedValue(undefined),
		query: jest.fn(),
		prepare: jest.fn().mockResolvedValue(mockStatement),
	};
	MockedExasolDriver.mockImplementation(() => mockDriver as unknown as ExasolDriver);
	return { mockDriver, mockStatement };
}
