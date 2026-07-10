import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import {
	runQuery,
	runRawStatement,
	runStatement,
} from '../../nodes/Exasol/operations/shared/statementRunner';

// Builds the SQLResponse<SQLQueriesResponse> shape returned by both driver.query(..., 'raw') and
// stmt.execute() for a SELECT result. The Exasol wire format is column-major: data[colIdx][rowIdx].
// This helper converts the friendlier row-major input so tests stay readable — same convention as
// selectRows.test.ts's and schemaExplorer.test.ts's identical helper.
function selectResult(rows: Record<string, unknown>[]) {
	const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
	return {
		status: 'ok',
		responseData: {
			numResults: 1,
			results: [
				{
					resultType: 'resultSet',
					resultSet: {
						numColumns: cols.length,
						numRows: rows.length,
						numRowsInMessage: rows.length,
						columns: cols.map((name) => ({ name, dataType: { type: 'VARCHAR' } })),
						data: cols.map((col) => rows.map((row) => row[col] ?? null)),
					},
				},
			],
		},
	};
}

type MockStatement = {
	execute: jest.Mock;
	close: jest.Mock;
};

function rowCountResult(rowCount: number) {
	return {
		status: 'ok',
		responseData: {
			numResults: 1,
			results: [{ resultType: 'rowCount', rowCount }],
		},
	};
}

describe('runStatement()', () => {
	let mockStatement: MockStatement;
	let mockDriver: { prepare: jest.Mock };

	beforeEach(() => {
		mockStatement = {
			execute: jest.fn().mockResolvedValue(rowCountResult(1)),
			close: jest.fn().mockResolvedValue(undefined),
		};
		mockDriver = { prepare: jest.fn().mockResolvedValue(mockStatement) };
	});

	it('prepares the query and returns the rowCount from a successful response', async () => {
		mockStatement.execute.mockResolvedValue(rowCountResult(3));

		const affectedRows = await runStatement(
			mockDriver as unknown as ExasolDriver,
			'INSERT INTO "S"."T" ("C") VALUES (?)',
			[1],
			'Statement failed',
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith('INSERT INTO "S"."T" ("C") VALUES (?)');
		expect(mockStatement.execute).toHaveBeenCalledWith(1);
		expect(affectedRows).toBe(3);
	});

	it('falls back to zero affected rows when rowCount is missing from the response', async () => {
		mockStatement.execute.mockResolvedValue({ status: 'ok', responseData: { results: [{}] } });

		const affectedRows = await runStatement(
			mockDriver as unknown as ExasolDriver,
			'UPDATE "S"."T" SET "C" = ?',
			[1],
			'Statement failed',
		);

		expect(affectedRows).toBe(0);
	});

	it('falls back to zero affected rows when the results array is empty', async () => {
		mockStatement.execute.mockResolvedValue({ status: 'ok', responseData: { results: [] } });

		const affectedRows = await runStatement(
			mockDriver as unknown as ExasolDriver,
			'UPDATE "S"."T" SET "C" = ?',
			[1],
			'Statement failed',
		);

		expect(affectedRows).toBe(0);
	});

	it('falls back to zero affected rows when results is missing from responseData', async () => {
		mockStatement.execute.mockResolvedValue({ status: 'ok', responseData: {} });

		const affectedRows = await runStatement(
			mockDriver as unknown as ExasolDriver,
			'UPDATE "S"."T" SET "C" = ?',
			[1],
			'Statement failed',
		);

		expect(affectedRows).toBe(0);
	});

	it('throws the failure message when responseData is missing entirely', async () => {
		mockStatement.execute.mockResolvedValue({ status: 'ok' });

		await expect(
			runStatement(
				mockDriver as unknown as ExasolDriver,
				'UPDATE "S"."T" SET "C" = ?',
				[1],
				'Statement failed',
			),
		).rejects.toThrow('Statement failed');
	});

	it('throws the exception text when the response status is an error', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'error',
			exception: { text: 'column not found' },
		});

		await expect(
			runStatement(mockDriver as unknown as ExasolDriver, 'SELECT 1', [], 'Statement failed'),
		).rejects.toThrow('column not found');
	});

	it('falls back to the provided failure message when the error response has no exception text', async () => {
		mockStatement.execute.mockResolvedValue({ status: 'error' });

		await expect(
			runStatement(mockDriver as unknown as ExasolDriver, 'SELECT 1', [], 'Statement failed'),
		).rejects.toThrow('Statement failed');
	});

	it('closes the prepared statement after a successful execution', async () => {
		await runStatement(mockDriver as unknown as ExasolDriver, 'SELECT 1', [], 'Statement failed');

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('closes the prepared statement even when execution fails', async () => {
		mockStatement.execute.mockRejectedValue(new Error('boom'));

		await expect(
			runStatement(mockDriver as unknown as ExasolDriver, 'SELECT 1', [], 'Statement failed'),
		).rejects.toThrow('boom');
		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('swallows a close() failure so it does not mask the original result', async () => {
		mockStatement.close.mockRejectedValue(new Error('close failed'));

		const affectedRows = await runStatement(
			mockDriver as unknown as ExasolDriver,
			'SELECT 1',
			[],
			'Statement failed',
		);

		expect(affectedRows).toBe(1);
	});
});

describe('runRawStatement()', () => {
	let mockDriver: { query: jest.Mock };

	beforeEach(() => {
		mockDriver = { query: jest.fn().mockResolvedValue(rowCountResult(1)) };
	});

	it('queries with the raw response type and returns the rowCount from a successful response', async () => {
		mockDriver.query.mockResolvedValue(rowCountResult(3));

		const affectedRows = await runRawStatement(
			mockDriver as unknown as ExasolDriver,
			'DELETE FROM "S"."T" WHERE "ID" = 1',
			'Statement failed',
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'DELETE FROM "S"."T" WHERE "ID" = 1',
			undefined,
			undefined,
			'raw',
		);
		expect(affectedRows).toBe(3);
	});

	it('falls back to zero affected rows when rowCount is missing from the response', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok', responseData: { results: [{}] } });

		const affectedRows = await runRawStatement(
			mockDriver as unknown as ExasolDriver,
			'DELETE FROM "S"."T" WHERE "ID" = 1',
			'Statement failed',
		);

		expect(affectedRows).toBe(0);
	});

	it('falls back to zero affected rows when the results array is empty', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok', responseData: { results: [] } });

		const affectedRows = await runRawStatement(
			mockDriver as unknown as ExasolDriver,
			'DELETE FROM "S"."T" WHERE "ID" = 1',
			'Statement failed',
		);

		expect(affectedRows).toBe(0);
	});

	it('falls back to zero affected rows when results is missing from responseData', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok', responseData: {} });

		const affectedRows = await runRawStatement(
			mockDriver as unknown as ExasolDriver,
			'DELETE FROM "S"."T" WHERE "ID" = 1',
			'Statement failed',
		);

		expect(affectedRows).toBe(0);
	});

	it('throws the failure message when responseData is missing entirely', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok' });

		await expect(
			runRawStatement(
				mockDriver as unknown as ExasolDriver,
				'DELETE FROM "S"."T" WHERE "ID" = 1',
				'Statement failed',
			),
		).rejects.toThrow('Statement failed');
	});

	it('throws the exception text when the response status is an error', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'error',
			exception: { text: 'column not found' },
		});

		await expect(
			runRawStatement(
				mockDriver as unknown as ExasolDriver,
				'DELETE FROM "S"."T"',
				'Statement failed',
			),
		).rejects.toThrow('column not found');
	});

	it('falls back to the provided failure message when the error response has no exception text', async () => {
		mockDriver.query.mockResolvedValue({ status: 'error' });

		await expect(
			runRawStatement(
				mockDriver as unknown as ExasolDriver,
				'DELETE FROM "S"."T"',
				'Statement failed',
			),
		).rejects.toThrow('Statement failed');
	});
});

describe('runQuery()', () => {
	let mockStatement: MockStatement;
	let mockDriver: { query: jest.Mock; prepare: jest.Mock };
	let context: IExecuteFunctions;

	beforeEach(() => {
		mockStatement = {
			execute: jest.fn().mockResolvedValue(selectResult([])),
			close: jest.fn().mockResolvedValue(undefined),
		};
		mockDriver = {
			query: jest.fn().mockResolvedValue(selectResult([])),
			prepare: jest.fn().mockResolvedValue(mockStatement),
		};
		context = {
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	});

	it('runs the raw path and returns pivoted rows when there are no bound params', async () => {
		mockDriver.query.mockResolvedValue(selectResult([{ ID: 1 }, { ID: 2 }]));

		const rows = await runQuery(context, mockDriver as unknown as ExasolDriver, 'SELECT * FROM T', [], 0);

		expect(mockDriver.query).toHaveBeenCalledWith('SELECT * FROM T', undefined, undefined, 'raw');
		expect(mockDriver.prepare).not.toHaveBeenCalled();
		expect(rows).toEqual([{ ID: 1 }, { ID: 2 }]);
	});

	it('prepares the statement and binds params when there are bound params', async () => {
		mockStatement.execute.mockResolvedValue(selectResult([{ ID: 1 }]));

		const rows = await runQuery(
			context,
			mockDriver as unknown as ExasolDriver,
			'SELECT * FROM T WHERE ID = ?',
			[1],
			0,
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith('SELECT * FROM T WHERE ID = ?');
		expect(mockStatement.execute).toHaveBeenCalledWith(1);
		expect(rows).toEqual([{ ID: 1 }]);
	});

	it('closes the prepared statement after execution', async () => {
		await runQuery(context, mockDriver as unknown as ExasolDriver, 'SELECT * FROM T WHERE ID = ?', [1], 0);

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('closes the prepared statement even when execution fails', async () => {
		mockStatement.execute.mockRejectedValue(new Error('boom'));

		await expect(
			runQuery(context, mockDriver as unknown as ExasolDriver, 'SELECT * FROM T WHERE ID = ?', [1], 0),
		).rejects.toThrow();
		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('returns an empty array when the response has no result set (defensive)', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok', responseData: { numResults: 0, results: [] } });

		const rows = await runQuery(context, mockDriver as unknown as ExasolDriver, 'SELECT * FROM T', [], 0);

		expect(rows).toEqual([]);
	});

	it('returns an empty array when responseData has no results array (defensive)', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok', responseData: {} });

		const rows = await runQuery(context, mockDriver as unknown as ExasolDriver, 'SELECT * FROM T', [], 0);

		expect(rows).toEqual([]);
	});

	it('throws NodeOperationError when responseData is missing entirely, instead of treating it as zero rows', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok' });

		const thrown = await runQuery(
			context,
			mockDriver as unknown as ExasolDriver,
			'SELECT * FROM T',
			[],
			0,
		).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toBe(
			'Query returned no response data (query: SELECT * FROM T)',
		);
	});

	it('throws NodeOperationError with the query text and itemIndex when the driver reports status: error', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-1', text: 'table not found' },
		});

		const thrown = await runQuery(
			context,
			mockDriver as unknown as ExasolDriver,
			'SELECT * FROM T',
			[],
			2,
		).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toBe(
			'table not found (query: SELECT * FROM T)',
		);
		expect((thrown as NodeOperationError).context).toMatchObject({ itemIndex: 2 });
	});

	it('falls back to a generic message when the error response has no exception details', async () => {
		mockDriver.query.mockResolvedValue({ status: 'error', exception: undefined });

		const thrown = await runQuery(
			context,
			mockDriver as unknown as ExasolDriver,
			'SELECT * FROM T',
			[],
			0,
		).catch((e) => e);

		expect((thrown as NodeOperationError).message).toBe('Query failed (query: SELECT * FROM T)');
	});

	it('wraps a rejected driver call with the query text too', async () => {
		mockDriver.query.mockRejectedValue(new Error('connection reset'));

		const thrown = await runQuery(
			context,
			mockDriver as unknown as ExasolDriver,
			'SELECT * FROM T',
			[],
			0,
		).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toBe(
			'connection reset (query: SELECT * FROM T)',
		);
	});
});
