import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
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
	query: jest.Mock;
	execute: jest.Mock;
	executeBatch: jest.Mock;
	prepare: jest.Mock;
	close: jest.Mock;
};

// Builds the SQLResponse<SQLQueriesResponse> shape returned by driver.query(..., 'raw')
// for a SELECT-style result. The Exasol wire format is column-major: data[colIdx][rowIdx].
// This helper converts the friendlier row-major input so tests stay readable.
function rawQueryResult(rows: Record<string, unknown>[]) {
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

// Builds the raw DML/DDL response (rowCount result type, no result set).
function rawDmlResult(rowCount = 0) {
	return {
		status: 'ok',
		responseData: {
			numResults: 1,
			results: [{ resultType: 'rowCount', rowCount }],
		},
	};
}

describe('execute()', () => {
	let node: Exasol;
	let mockDriver: MockDriver;
	let mockStatement: MockStatement;

	beforeEach(() => {
		node = new Exasol();
		mockStatement = {
			execute: jest.fn(),
			close: jest.fn().mockResolvedValue(undefined),
		};
		mockDriver = {
			connect: jest.fn().mockResolvedValue(undefined),
			query: jest.fn(),
			execute: jest.fn().mockResolvedValue(0),
			executeBatch: jest.fn(),
			prepare: jest.fn().mockResolvedValue(mockStatement),
			close: jest.fn().mockResolvedValue(undefined),
		};
		MockedExasolDriver.mockImplementation(() => mockDriver as unknown as ExasolDriver);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	/**
	 * Builds a minimal IExecuteFunctions context for unit tests.
	 *
	 * The context wires together the fields the node's execute() reads:
	 * - getCredentials: returns static localhost credentials
	 * - getInputData: returns opts.items (defaults to one empty item)
	 * - getNodeParameter: dispatches by name; 'query' returns opts.query (string
	 *   for all items, or string[] indexed by item), 'executionMode' returns
	 *   opts.executionMode (default: 'sequentially'), 'parameters' returns a
	 *   fixedCollection-shaped object from opts.parameters.
	 * - continueOnFail: returns opts.continueOnFail (default: false)
	 */
	function makeContext(
		opts: {
			items?: INodeExecutionData[];
			query?: string | string[];
			parameters?: Array<{ value: unknown }>;
			executionMode?: string;
			continueOnFail?: boolean;
		} = {},
	): IExecuteFunctions {
		return {
			getCredentials: jest.fn().mockResolvedValue({
				host: 'localhost',
				port: 8563,
				user: 'u',
				password: 'p',
				schema: '',
			}),
			getInputData: jest.fn().mockReturnValue(opts.items ?? [{ json: {} }]),
			// getNodeParameter reads per-item parameter values; the item index argument
			// is required because expressions (={{$json.query}}) vary per input item.
			// The optional third argument is the fallback n8n returns for unset fields.
			getNodeParameter: jest
				.fn()
				.mockImplementation((name: string, itemIndex?: number, fallback?: unknown) => {
					if (name === 'operation') return 'executeQuery';
					if (name === 'executionMode') return opts.executionMode ?? fallback ?? 'sequentially';
					if (name === 'parameters') {
						return !opts.parameters ? (fallback ?? {}) : { values: opts.parameters };
					}
					if (name === 'query') {
						if (Array.isArray(opts.query)) return opts.query[itemIndex ?? 0] ?? '';
						return opts.query ?? 'SELECT 1';
					}
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
			addExecutionHints: jest.fn(),
		} as unknown as IExecuteFunctions;
	}

	// ── Raw (non-parameterized) path — SELECT ────────────────────────────────────

	it('maps query rows to INodeExecutionData items', async () => {
		mockDriver.query.mockResolvedValue(rawQueryResult([{ id: 1 }, { id: 2 }]));

		const [result] = await node.execute.call(makeContext());

		expect(result).toHaveLength(2);
		expect(result[0].json).toEqual({ id: 1 });
		expect(result[1].json).toEqual({ id: 2 });
	});

	it('sets pairedItem.item to the input item index', async () => {
		mockDriver.query
			.mockResolvedValueOnce(rawQueryResult([{ a: 1 }]))
			.mockResolvedValueOnce(rawQueryResult([{ b: 2 }]));

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }] });
		const [result] = await node.execute.call(ctx);

		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('returns an empty array when the query yields no rows', async () => {
		mockDriver.query.mockResolvedValue(rawQueryResult([]));

		const [result] = await node.execute.call(makeContext());

		expect(result).toHaveLength(0);
	});

	it('concatenates rows from multiple input items', async () => {
		mockDriver.query
			.mockResolvedValueOnce(rawQueryResult([{ a: 1 }]))
			.mockResolvedValueOnce(rawQueryResult([{ b: 2 }]));

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }] });
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result[0].json).toEqual({ a: 1 });
		expect(result[1].json).toEqual({ b: 2 });
	});

	// ── Raw path — non-SELECT (DML / DDL) ───────────────────────────────────────

	it('returns { affectedRows: N } for raw non-SELECT queries', async () => {
		mockDriver.query.mockResolvedValueOnce(rawDmlResult(5));

		const ctx = makeContext({ query: 'DELETE FROM t WHERE id > 0' });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 5 });
	});

	it('routes INSERT, UPDATE, DELETE, and DDL through driver.query() raw path', async () => {
		// All non-parameterized queries use driver.query(..., 'raw') regardless of
		// statement type — the result type in the response tells us whether to return
		// rows or { affectedRows: N }.
		for (const dml of [
			'INSERT INTO t VALUES (1)',
			'UPDATE t SET a = 1',
			'DELETE FROM t',
			'CREATE TABLE t (id INTEGER)',
		]) {
			jest.clearAllMocks();
			mockDriver.query.mockResolvedValueOnce(rawDmlResult(0));

			await node.execute.call(makeContext({ query: dml }));

			expect(mockDriver.query).toHaveBeenCalledWith(dml, undefined, undefined, 'raw');
			// driver.execute() is reserved for COMMIT/ROLLBACK in transaction mode
			expect(mockDriver.execute).not.toHaveBeenCalled();
		}
	});

	it('correctly handles WITH...SELECT (CTE returning rows)', async () => {
		mockDriver.query.mockResolvedValueOnce(rawQueryResult([{ n: 1 }]));

		const ctx = makeContext({ query: 'WITH cte AS (SELECT 1 AS n) SELECT * FROM cte' });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ n: 1 });
	});

	it('correctly handles WITH...INSERT (CTE used in DML)', async () => {
		mockDriver.query.mockResolvedValueOnce(rawDmlResult(2));

		const ctx = makeContext({ query: 'WITH src AS (SELECT 1) INSERT INTO t SELECT * FROM src' });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 2 });
	});

	// ── Driver lifecycle ─────────────────────────────────────────────────────────

	it('closes the driver after a successful run', async () => {
		mockDriver.query.mockResolvedValue(rawQueryResult([]));

		await node.execute.call(makeContext());

		expect(mockDriver.close).toHaveBeenCalledTimes(1);
	});

	it('closes the driver even when a query fails', async () => {
		mockDriver.query.mockRejectedValue(new Error('boom'));

		await expect(node.execute.call(makeContext())).rejects.toThrow();

		expect(mockDriver.close).toHaveBeenCalledTimes(1);
	});

	it('suppresses driver.close() errors so the real operation result is returned', async () => {
		mockDriver.query.mockResolvedValue(rawQueryResult([{ id: 1 }]));
		mockDriver.close.mockRejectedValue(new Error('close failed'));

		// The close error must be swallowed; the operation result is what the caller sees.
		const [[item]] = await node.execute.call(makeContext());

		expect(item.json).toEqual({ id: 1 });
	});

	// ── Error handling (sequentially mode) ─────────────────────────────────────

	it('stores error in json when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad sql'));

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ error: 'bad sql' });
	});

	it('sets pairedItem on error output when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad sql'));

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }], continueOnFail: true });
		const [result] = await node.execute.call(ctx);

		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('throws NodeOperationError when continueOnFail is false', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad sql'));

		await expect(
			node.execute.call(makeContext({ continueOnFail: false })),
		).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('returns error item when driver.connect() fails and continueOnFail is true', async () => {
		mockDriver.connect.mockRejectedValue(new Error('connection refused'));

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ error: 'connection refused' });
	});

	it('returns one error item per input item when connect() fails and continueOnFail is true', async () => {
		mockDriver.connect.mockRejectedValue(new Error('connection refused'));

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }], continueOnFail: true });
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('throws NodeOperationError when driver.connect() fails and continueOnFail is false', async () => {
		mockDriver.connect.mockRejectedValue(new Error('connection refused'));

		await expect(node.execute.call(makeContext())).rejects.toBeInstanceOf(NodeOperationError);
		expect(mockDriver.close).toHaveBeenCalledTimes(1);
	});

	it('uses fallback message when driver returns status:error with empty exception text', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-42', text: '' },
		});

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json.error).toBe('Query execution failed');
	});

	it('throws when status is ok but responseData is missing', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok' });

		await expect(node.execute.call(makeContext())).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('returns { affectedRows: 0 } when responseData exists but has no results property', async () => {
		// Defensive edge case: responseData is present (so the "missing responseData" check
		// above doesn't fire) but its results array is absent.
		mockDriver.query.mockResolvedValue({ status: 'ok', responseData: {} });

		const [[item]] = await node.execute.call(makeContext());

		expect(item.json).toEqual({ affectedRows: 0 });
	});

	it('throws NodeOperationError for an empty query string', async () => {
		const ctx = makeContext({ query: '' });

		await expect(node.execute.call(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('stores empty-query error in json when continueOnFail is true', async () => {
		const ctx = makeContext({ query: '   ', continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toMatchObject({ error: expect.stringContaining('empty') });
	});

	// ── Parameterized path (prepare + stmt.execute) ──────────────────────────────

	it('uses prepare() when parameters are provided', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			exception: undefined,
			responseData: {
				numResults: 1,
				results: [
					{
						resultType: 'resultSet',
						resultSet: {
							numColumns: 1,
							numRows: 1,
							numRowsInMessage: 1,
							columns: [{ name: 'N', dataType: { type: 'DECIMAL' } }],
							data: [[42]],
						},
					},
				],
			},
		});

		const ctx = makeContext({
			query: 'SELECT ? AS N',
			parameters: [{ value: 42 }],
		});
		const [result] = await node.execute.call(ctx);

		expect(mockDriver.prepare).toHaveBeenCalledWith('SELECT ? AS N');
		expect(mockStatement.execute).toHaveBeenCalledWith(42);
		expect(result[0].json).toEqual({ N: 42 });
	});

	it('returns { affectedRows: N } for parameterized DML', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			exception: undefined,
			responseData: {
				numResults: 1,
				results: [{ resultType: 'rowCount', rowCount: 3 }],
			},
		});

		const ctx = makeContext({
			query: 'INSERT INTO t VALUES (?)',
			parameters: [{ value: 'x' }],
		});
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 3 });
	});

	it('returns { affectedRows: 0 } when parameterized path returns empty results array', async () => {
		// Edge case: a valid 'ok' response with no results (certain DDL statements).
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			exception: undefined,
			responseData: { numResults: 0, results: [] },
		});

		const ctx = makeContext({
			query: 'CREATE TABLE t (id INTEGER)',
			parameters: [{ value: 1 }],
		});
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 0 });
	});

	it('does not call prepare() when no parameters are provided (raw path)', async () => {
		mockDriver.query.mockResolvedValue(rawQueryResult([{ n: 1 }]));

		await node.execute.call(makeContext({ query: 'SELECT 1 AS n' }));

		expect(mockDriver.prepare).not.toHaveBeenCalled();
		expect(mockDriver.query).toHaveBeenCalledWith('SELECT 1 AS n', undefined, undefined, 'raw');
	});

	it('closes the prepared statement after execution', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			exception: undefined,
			responseData: {
				numResults: 1,
				results: [{ resultType: 'rowCount', rowCount: 1 }],
			},
		});

		await node.execute.call(
			makeContext({ query: 'INSERT INTO t VALUES (?)', parameters: [{ value: 1 }] }),
		);

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('closes the prepared statement even when execution fails', async () => {
		mockStatement.execute.mockRejectedValue(new Error('stmt error'));

		await expect(
			node.execute.call(
				makeContext({ query: 'BAD SQL ?', parameters: [{ value: 1 }], continueOnFail: false }),
			),
		).rejects.toThrow();

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('passes multiple parameter values as positional arguments to stmt.execute()', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			exception: undefined,
			responseData: {
				numResults: 1,
				results: [{ resultType: 'rowCount', rowCount: 1 }],
			},
		});

		const ctx = makeContext({
			query: 'INSERT INTO t VALUES (?, ?)',
			parameters: [{ value: 'a' }, { value: 'b' }],
		});
		await node.execute.call(ctx);

		expect(mockStatement.execute).toHaveBeenCalledWith('a', 'b');
	});

	it('pivots columnar ResultSet data to row objects', async () => {
		// data[0] = column A values = [10, 20]; data[1] = column B values = [30, 40]
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			exception: undefined,
			responseData: {
				numResults: 1,
				results: [
					{
						resultType: 'resultSet',
						resultSet: {
							numColumns: 2,
							numRows: 2,
							numRowsInMessage: 2,
							columns: [
								{ name: 'A', dataType: { type: 'INTEGER' } },
								{ name: 'B', dataType: { type: 'INTEGER' } },
							],
							data: [
								[10, 20],
								[30, 40],
							],
						},
					},
				],
			},
		});

		// Two parameters for two ? placeholders
		const ctx = makeContext({
			query: 'SELECT ? AS A, ? AS B FROM DUAL',
			parameters: [{ value: 1 }, { value: 2 }],
		});
		const [result] = await node.execute.call(ctx);

		expect(result[0].json).toEqual({ A: 10, B: 30 });
		expect(result[1].json).toEqual({ A: 20, B: 40 });
	});

	it('surfaces status: error from prepared statement as an error item (continueOnFail)', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-22', text: 'type mismatch' },
			responseData: { numResults: 0, results: [] },
		});

		const ctx = makeContext({
			query: 'INSERT INTO t VALUES (?)',
			parameters: [{ value: 'x' }],
			continueOnFail: true,
		});
		const [[item]] = await node.execute.call(ctx);

		expect(item.json.error).toBe('type mismatch');
	});

	it('throws NodeOperationError for status: error when continueOnFail is false', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-22', text: 'type mismatch' },
			responseData: { numResults: 0, results: [] },
		});

		const ctx = makeContext({
			query: 'INSERT INTO t VALUES (?)',
			parameters: [{ value: 'x' }],
			continueOnFail: false,
		});

		await expect(node.execute.call(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});

	// ── Execution modes ──────────────────────────────────────────────────────────

	it('defaults to sequentially mode when executionMode is not set', async () => {
		mockDriver.query.mockResolvedValue(rawQueryResult([{ n: 1 }]));

		const [result] = await node.execute.call(makeContext());

		expect(result).toHaveLength(1);
		// sequentially mode does not call driver.execute() for transaction control
		expect(mockDriver.execute).not.toHaveBeenCalled();
	});

	describe('transaction mode', () => {
		it('calls COMMIT with autocommit: false to start transaction, then COMMIT on success, then restores autocommit', async () => {
			mockDriver.query.mockResolvedValue(rawQueryResult([]));

			const ctx = makeContext({ executionMode: 'transaction' });
			await node.execute.call(ctx);

			expect(mockDriver.execute).toHaveBeenNthCalledWith(1, 'COMMIT', { autocommit: false });
			expect(mockDriver.execute).toHaveBeenNthCalledWith(2, 'COMMIT');
			expect(mockDriver.execute).toHaveBeenNthCalledWith(3, 'COMMIT', { autocommit: true });
		});

		it('calls ROLLBACK when any item fails', async () => {
			mockDriver.query.mockRejectedValue(new Error('query failed'));

			const ctx = makeContext({ executionMode: 'transaction' });
			await expect(node.execute.call(ctx)).rejects.toBeInstanceOf(NodeOperationError);

			expect(mockDriver.execute).toHaveBeenCalledWith('ROLLBACK');
		});

		it('rolls back even when the second item fails after the first succeeds', async () => {
			mockDriver.query
				.mockResolvedValueOnce(rawQueryResult([{ a: 1 }]))
				.mockRejectedValueOnce(new Error('second item failed'));

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'transaction',
			});
			await expect(node.execute.call(ctx)).rejects.toBeInstanceOf(NodeOperationError);

			expect(mockDriver.execute).toHaveBeenCalledWith('ROLLBACK');
		});

		it('returns all item results when transaction succeeds', async () => {
			mockDriver.query
				.mockResolvedValueOnce(rawQueryResult([{ a: 1 }]))
				.mockResolvedValueOnce(rawQueryResult([{ b: 2 }]));

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'transaction',
			});
			const [result] = await node.execute.call(ctx);

			expect(result).toHaveLength(2);
			expect(result[0].json).toEqual({ a: 1 });
			expect(result[1].json).toEqual({ b: 2 });
		});

		it('throws NodeOperationError on empty query in transaction mode', async () => {
			const ctx = makeContext({ query: '', executionMode: 'transaction' });
			await expect(node.execute.call(ctx)).rejects.toBeInstanceOf(NodeOperationError);
			expect(mockDriver.execute).toHaveBeenCalledWith('ROLLBACK');
		});

		it('preserves itemIndex from empty-query errors in transaction mode', async () => {
			// item 0 runs fine; item 1 has an empty query — the thrown error must carry itemIndex: 1
			mockDriver.query.mockResolvedValueOnce(rawQueryResult([]));

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				query: ['SELECT 1', ''],
				executionMode: 'transaction',
			});
			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).context?.itemIndex).toBe(1);
		});

		it('preserves itemIndex from DB-level errors in transaction mode', async () => {
			// item 0 succeeds; item 1 causes a DB error — itemIndex must be 1
			mockDriver.query
				.mockResolvedValueOnce(rawQueryResult([]))
				.mockRejectedValueOnce(new Error('syntax error near '));

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'transaction',
			});
			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).context?.itemIndex).toBe(1);
		});

		it('returns an error item instead of throwing when continueOnFail is true', async () => {
			mockDriver.query.mockRejectedValue(new Error('query failed'));

			const ctx = makeContext({ executionMode: 'transaction', continueOnFail: true });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toMatchObject({ error: expect.any(String) });
			expect(mockDriver.execute).toHaveBeenCalledWith('ROLLBACK');
		});
	});

	describe('single mode', () => {
		it('sends all items in one executeBatch call and maps results by index', async () => {
			mockDriver.executeBatch.mockResolvedValue({
				status: 'ok',
				responseData: {
					numResults: 2,
					results: [
						{
							resultType: 'resultSet',
							resultSet: {
								numColumns: 1,
								numRows: 1,
								numRowsInMessage: 1,
								columns: [{ name: 'N', dataType: { type: 'DECIMAL' } }],
								data: [[1]],
							},
						},
						{ resultType: 'rowCount', rowCount: 1 },
					],
				},
			});

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'single',
				query: ['SELECT 1 AS N', 'INSERT INTO t VALUES (2)'],
			});
			const [result] = await node.execute.call(ctx);

			expect(mockDriver.executeBatch).toHaveBeenCalledWith([
				'SELECT 1 AS N',
				'INSERT INTO t VALUES (2)',
			]);
			expect(result[0].json).toEqual({ N: 1 });
			expect(result[0].pairedItem).toEqual({ item: 0 });
			expect(result[1].json).toEqual({ affectedRows: 1 });
			expect(result[1].pairedItem).toEqual({ item: 1 });
			expect(mockDriver.query).not.toHaveBeenCalled();
			expect(mockDriver.prepare).not.toHaveBeenCalled();
		});

		it('returns an empty array for zero items without touching the driver', async () => {
			const ctx = makeContext({ items: [], executionMode: 'single' });
			const [result] = await node.execute.call(ctx);

			expect(result).toEqual([]);
			expect(mockDriver.executeBatch).not.toHaveBeenCalled();
		});

		it('does not open a transaction around the batch call', async () => {
			// Single Batch mode intentionally has no transactional safety net — wrapping
			// the batch in a transaction would serialize every write behind it even on
			// the happy path, defeating the point of sending it in one round-trip.
			mockDriver.executeBatch.mockResolvedValue({
				status: 'ok',
				responseData: { numResults: 1, results: [{ resultType: 'rowCount', rowCount: 1 }] },
			});

			const ctx = makeContext({ executionMode: 'single', query: 'INSERT INTO t VALUES (1)' });
			await node.execute.call(ctx);

			expect(mockDriver.execute).not.toHaveBeenCalled();
		});

		it('falls back to Sequentially and warns when an item uses Parameters', async () => {
			mockStatement.execute.mockResolvedValue({
				status: 'ok',
				exception: undefined,
				responseData: { numResults: 1, results: [{ resultType: 'rowCount', rowCount: 1 }] },
			});

			const ctx = makeContext({
				executionMode: 'single',
				query: 'INSERT INTO t VALUES (?)',
				parameters: [{ value: 1 }],
			});
			const [[item]] = await node.execute.call(ctx);

			expect(mockDriver.executeBatch).not.toHaveBeenCalled();
			expect(mockDriver.prepare).toHaveBeenCalled();
			expect(item.json).toEqual({ affectedRows: 1 });
			expect(ctx.addExecutionHints).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'warning' }),
			);
		});

		it("evaluates each item's Query expression only once even when falling back due to Parameters", async () => {
			// Regression test: the fallback path used to re-read 'query'/'parameters' via
			// executeSequentially's own readQuery/extractParams calls, evaluating any n8n
			// expression in those fields a second time. Non-idempotent expressions (e.g.
			// ={{ $now.toMillis() }}) would then resolve to a different value than the one
			// used to decide whether to fall back in the first place.
			mockStatement.execute.mockResolvedValue({
				status: 'ok',
				exception: undefined,
				responseData: { numResults: 1, results: [{ resultType: 'rowCount', rowCount: 1 }] },
			});

			const ctx = makeContext({
				executionMode: 'single',
				query: 'INSERT INTO t VALUES (?)',
				parameters: [{ value: 1 }],
			});
			await node.execute.call(ctx);

			const queryReadsForItem0 = (ctx.getNodeParameter as jest.Mock).mock.calls.filter(
				([name, itemIndex]) => name === 'query' && itemIndex === 0,
			);
			const paramReadsForItem0 = (ctx.getNodeParameter as jest.Mock).mock.calls.filter(
				([name, itemIndex]) => name === 'parameters' && itemIndex === 0,
			);
			expect(queryReadsForItem0).toHaveLength(1);
			expect(paramReadsForItem0).toHaveLength(1);
		});

		it('throws NodeOperationError with the real itemIndex when a query is empty (no batch attempted)', async () => {
			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'single',
				query: ['SELECT 1', ''],
			});
			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).context?.itemIndex).toBe(1);
			expect(mockDriver.executeBatch).not.toHaveBeenCalled();
		});

		it('stores one error item per input item (same message) for an empty query when continueOnFail is true', async () => {
			// The empty query is only found on item 1, but since the batch was never
			// sent, there's no way to know item 0 would have succeeded — every item is
			// reported as failed so the output item count still matches the input.
			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'single',
				query: ['SELECT 1', ''],
				continueOnFail: true,
			});
			const [result] = await node.execute.call(ctx);

			expect(result).toHaveLength(2);
			expect(result[0].json).toMatchObject({ error: expect.stringContaining('empty') });
			expect(result[1].json).toEqual(result[0].json);
			expect(result[0].pairedItem).toEqual({ item: 0 });
			expect(result[1].pairedItem).toEqual({ item: 1 });
		});

		it('throws NodeOperationError attributed to item 0 when the batch reports status: error', async () => {
			// The batch protocol gives no way to tell which statement failed, so the
			// failure is reported against item 0 rather than the real culprit — the same
			// trade-off MySQL's "Single" query-batching mode makes.
			mockDriver.executeBatch.mockResolvedValue({
				status: 'error',
				exception: { sqlCode: 'E-1', text: 'syntax error' },
			});

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'single',
				query: ['INSERT INTO t VALUES (1)', 'BAD SQL'],
			});
			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).message).toContain('syntax error');
			expect((thrown as NodeOperationError).context?.itemIndex).toBe(0);
			expect(mockDriver.query).not.toHaveBeenCalled();
		});

		it('returns one error item per input item (same message) when the batch fails and continueOnFail is true', async () => {
			mockDriver.executeBatch.mockResolvedValue({
				status: 'error',
				exception: { sqlCode: 'E-1', text: 'bad statement' },
			});

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'single',
				query: ['INSERT INTO t VALUES (1)', 'BAD SQL'],
				continueOnFail: true,
			});
			const [result] = await node.execute.call(ctx);

			expect(result).toEqual([
				{ json: { error: 'bad statement' }, pairedItem: { item: 0 } },
				{ json: { error: 'bad statement' }, pairedItem: { item: 1 } },
			]);
		});

		it('uses a fallback message when the batch error has no exception details', async () => {
			mockDriver.executeBatch.mockResolvedValue({ status: 'error', exception: undefined });

			const ctx = makeContext({ executionMode: 'single', continueOnFail: true });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toEqual({ error: 'Batch execution failed' });
		});

		it('treats a batch response with no responseData as affectedRows: 0 for a single item (no ambiguity)', async () => {
			// With exactly one item there's nothing to mis-map: whatever came back
			// (nothing, here) unambiguously belongs to that one item.
			mockDriver.executeBatch.mockResolvedValue({ status: 'ok' });

			const ctx = makeContext({ executionMode: 'single' });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toEqual({ affectedRows: 0 });
		});

		it('throws NodeOperationError when the batch returns fewer results than items (e.g. a DDL statement produced none)', async () => {
			// mapSingleResult's own comment documents that certain DDL statements produce
			// zero entries in the results array. With 3 items but only 2 results, results
			// can no longer be safely mapped back to items by position.
			mockDriver.executeBatch.mockResolvedValue({
				status: 'ok',
				responseData: {
					numResults: 2,
					results: [
						{ resultType: 'rowCount', rowCount: 1 },
						{ resultType: 'rowCount', rowCount: 1 },
					],
				},
			});

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }, { json: {} }],
				executionMode: 'single',
				query: ['CREATE TABLE t (id INTEGER)', 'INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)'],
			});
			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).message).toContain('one result per item');
		});

		it('returns one error item per input item when the batch result count mismatches and continueOnFail is true', async () => {
			mockDriver.executeBatch.mockResolvedValue({
				status: 'ok',
				responseData: { numResults: 1, results: [{ resultType: 'rowCount', rowCount: 1 }] },
			});

			const ctx = makeContext({
				items: [{ json: {} }, { json: {} }],
				executionMode: 'single',
				continueOnFail: true,
			});
			const [result] = await node.execute.call(ctx);

			expect(result).toHaveLength(2);
			expect(result[0].json).toMatchObject({ error: expect.stringContaining('one result per item') });
			expect(result[1].json).toEqual(result[0].json);
		});

		it('throws NodeOperationError attributed to item 0 when executeBatch itself rejects', async () => {
			mockDriver.executeBatch.mockRejectedValue(new Error('connection reset'));

			const ctx = makeContext({ executionMode: 'single', query: 'INSERT INTO t VALUES (1)' });
			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).message).toContain('connection reset');
			expect((thrown as NodeOperationError).context?.itemIndex).toBe(0);
		});
	});
});
