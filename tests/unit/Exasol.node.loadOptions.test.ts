import type { ILoadOptionsFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { ExasolDriver } from '@exasol/exasol-driver-ts';
import { Exasol } from '../../nodes/Exasol/Exasol.node';

jest.mock('@exasol/exasol-driver-ts');

const MockedExasolDriver = jest.mocked(ExasolDriver);

type MockStatement = {
	execute: jest.Mock;
	close: jest.Mock;
};

type MockDriver = {
	connect: jest.Mock;
	close: jest.Mock;
	query: jest.Mock;
	prepare: jest.Mock;
};

// Builds the raw SQLResponse<SQLQueriesResponse> shape returned by stmt.execute() for a
// single-column result set, as consumed by listTables' firstColumnValues() helper.
function singleColumnResult(values: string[]) {
	return {
		status: 'ok',
		responseData: {
			numResults: 1,
			results: [
				{
					resultType: 'resultSet',
					resultSet: {
						numColumns: 1,
						numRows: values.length,
						numRowsInMessage: values.length,
						columns: [{ name: 'TABLE_NAME', dataType: { type: 'VARCHAR' } }],
						data: [values],
					},
				},
			],
		},
	};
}

describe('Exasol node loadOptions', () => {
	let node: Exasol;
	let mockDriver: MockDriver;
	let mockStatement: MockStatement;

	beforeEach(() => {
		node = new Exasol();
		mockStatement = {
			execute: jest.fn().mockResolvedValue(singleColumnResult([])),
			close: jest.fn().mockResolvedValue(undefined),
		};
		mockDriver = {
			connect: jest.fn().mockResolvedValue(undefined),
			close: jest.fn().mockResolvedValue(undefined),
			query: jest.fn(),
			prepare: jest.fn().mockResolvedValue(mockStatement),
		};
		MockedExasolDriver.mockImplementation(() => mockDriver as unknown as ExasolDriver);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	function makeContext(opts: { schema?: string } = {}): ILoadOptionsFunctions {
		return {
			getCredentials: jest.fn().mockResolvedValue({
				host: 'localhost',
				port: 8563,
				user: 'u',
				password: 'p',
				schema: '',
			}),
			getCurrentNodeParameter: jest.fn().mockReturnValue(opts.schema),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as ILoadOptionsFunctions;
	}

	describe('listSchemas', () => {
		it('returns one option per schema, using SCHEMA_NAME for both name and value', async () => {
			mockDriver.query.mockResolvedValue({
				getRows: () => [{ SCHEMA_NAME: 'FOO' }, { SCHEMA_NAME: 'BAR' }],
			});

			const options = await node.methods.loadOptions.listSchemas.call(makeContext());

			expect(mockDriver.query).toHaveBeenCalledWith(
				'SELECT SCHEMA_NAME FROM EXA_ALL_SCHEMAS ORDER BY SCHEMA_NAME',
			);
			expect(options).toEqual([
				{ name: 'FOO', value: 'FOO' },
				{ name: 'BAR', value: 'BAR' },
			]);
		});

		it('returns an empty list when there are no schemas', async () => {
			mockDriver.query.mockResolvedValue({ getRows: () => [] });

			const options = await node.methods.loadOptions.listSchemas.call(makeContext());

			expect(options).toEqual([]);
		});

		it('closes the driver connection after querying', async () => {
			mockDriver.query.mockResolvedValue({ getRows: () => [] });

			await node.methods.loadOptions.listSchemas.call(makeContext());

			expect(mockDriver.close).toHaveBeenCalledTimes(1);
		});

		it('closes the driver connection even when the query fails', async () => {
			mockDriver.query.mockRejectedValue(new Error('connection refused'));

			await expect(node.methods.loadOptions.listSchemas.call(makeContext())).rejects.toThrow(
				'connection refused',
			);
			expect(mockDriver.close).toHaveBeenCalledTimes(1);
		});
	});

	describe('listTables', () => {
		it('returns an empty list without querying when no schema is selected yet', async () => {
			const options = await node.methods.loadOptions.listTables.call(makeContext());

			expect(options).toEqual([]);
			expect(mockDriver.connect).not.toHaveBeenCalled();
		});

		it('queries EXA_ALL_TABLES filtered by the currently selected schema', async () => {
			mockStatement.execute.mockResolvedValue(singleColumnResult(['ITEMS', 'ORDERS']));

			const options = await node.methods.loadOptions.listTables.call(
				makeContext({ schema: 'MY_SCHEMA' }),
			);

			expect(mockDriver.prepare).toHaveBeenCalledWith(
				'SELECT TABLE_NAME FROM EXA_ALL_TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
			);
			expect(mockStatement.execute).toHaveBeenCalledWith('MY_SCHEMA');
			expect(options).toEqual([
				{ name: 'ITEMS', value: 'ITEMS' },
				{ name: 'ORDERS', value: 'ORDERS' },
			]);
		});

		it('returns an empty list when the schema has no tables', async () => {
			mockStatement.execute.mockResolvedValue(singleColumnResult([]));

			const options = await node.methods.loadOptions.listTables.call(
				makeContext({ schema: 'EMPTY_SCHEMA' }),
			);

			expect(options).toEqual([]);
		});

		it('throws NodeOperationError when the driver reports status: error', async () => {
			mockStatement.execute.mockResolvedValue({
				status: 'error',
				exception: { sqlCode: 'E-1', text: 'schema not found' },
			});

			await expect(
				node.methods.loadOptions.listTables.call(makeContext({ schema: 'MISSING' })),
			).rejects.toBeInstanceOf(NodeOperationError);
		});

		it('closes the statement and driver connection after querying', async () => {
			mockStatement.execute.mockResolvedValue(singleColumnResult([]));

			await node.methods.loadOptions.listTables.call(makeContext({ schema: 'MY_SCHEMA' }));

			expect(mockStatement.close).toHaveBeenCalledTimes(1);
			expect(mockDriver.close).toHaveBeenCalledTimes(1);
		});
	});
});
