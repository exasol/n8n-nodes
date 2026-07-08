import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import {
	runRawStatement,
	runStatement,
} from '../../nodes/Exasol/operations/shared/statementRunner';

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
