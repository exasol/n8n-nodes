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
	close: jest.Mock;
	query: jest.Mock;
	prepare: jest.Mock;
};

// Builds the SQLResponse<SQLQueriesResponse> shape returned by both driver.query(..., 'raw')
// and stmt.execute() for a SELECT result. The Exasol wire format is column-major:
// data[colIdx][rowIdx]. This helper converts the friendlier row-major input so tests stay
// readable.
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

describe('Select Rows operation', () => {
	let node: Exasol;
	let mockDriver: MockDriver;
	let mockStatement: MockStatement;

	beforeEach(() => {
		node = new Exasol();
		mockStatement = {
			execute: jest.fn().mockResolvedValue(selectResult([])),
			close: jest.fn().mockResolvedValue(undefined),
		};
		mockDriver = {
			connect: jest.fn().mockResolvedValue(undefined),
			close: jest.fn().mockResolvedValue(undefined),
			query: jest.fn().mockResolvedValue(selectResult([])),
			prepare: jest.fn().mockResolvedValue(mockStatement),
		};
		MockedExasolDriver.mockImplementation(() => mockDriver as unknown as ExasolDriver);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	/**
	 * Builds a minimal IExecuteFunctions context wired to the "Select Rows" parameter shape.
	 * getNodeParameter dispatches by name, mirroring the fixedCollection shapes n8n produces
	 * for "where" ({ conditions: [...] }) and "sort" ({ rules: [...] }).
	 */
	function makeContext(
		opts: {
			items?: INodeExecutionData[];
			schema?: string;
			table?: string;
			returnAll?: boolean;
			// unknown, not number: some tests simulate an n8n expression resolving to a
			// non-numeric value, which getNodeParameter would return as-is at runtime.
			limit?: unknown;
			combineConditions?: unknown;
			where?: { conditions?: Array<{ column: string; operator: string; value?: unknown }> };
			sort?: { rules?: Array<{ column: string; direction: unknown }> };
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
			getNodeParameter: jest
				.fn()
				.mockImplementation((name: string, _itemIndex?: number, fallback?: unknown) => {
					if (name === 'operation') return 'selectRows';
					if (name === 'schema') return opts.schema ?? 'MY_SCHEMA';
					if (name === 'table') return opts.table ?? 'MY_TABLE';
					if (name === 'returnAll') return opts.returnAll ?? fallback ?? true;
					if (name === 'limit') return opts.limit ?? fallback ?? 50;
					if (name === 'combineConditions') return opts.combineConditions ?? fallback ?? 'AND';
					if (name === 'where') return opts.where ?? fallback ?? {};
					if (name === 'sort') return opts.sort ?? fallback ?? {};
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
			addExecutionHints: jest.fn(),
		} as unknown as IExecuteFunctions;
	}

	// ── Basic SELECT — raw path (no WHERE params) ──────────────────────────────────

	it('builds SELECT * FROM "schema"."table" via the raw path when there are no WHERE params', async () => {
		mockDriver.query.mockResolvedValue(selectResult([{ ID: 1 }]));

		const [result] = await node.execute.call(makeContext());

		expect(mockDriver.query).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE"',
			undefined,
			undefined,
			'raw',
		);
		expect(mockDriver.prepare).not.toHaveBeenCalled();
		expect(result[0].json).toEqual({ ID: 1 });
	});

	it('maps result rows to INodeExecutionData with pairedItem set to the input item index', async () => {
		mockDriver.query.mockResolvedValue(selectResult([{ ID: 1 }, { ID: 2 }]));

		const [result] = await node.execute.call(makeContext());

		expect(result).toHaveLength(2);
		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 0 });
	});

	it('returns an empty array when the query yields no rows', async () => {
		mockDriver.query.mockResolvedValue(selectResult([]));

		const [result] = await node.execute.call(makeContext());

		expect(result).toHaveLength(0);
	});

	it('converts a null cell to null rather than undefined', async () => {
		mockDriver.query.mockResolvedValue(selectResult([{ ID: 1, NOTES: null }]));

		const [[item]] = await node.execute.call(makeContext());

		expect(item.json).toEqual({ ID: 1, NOTES: null });
	});

	it('returns no rows when the response has no results (defensive)', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'ok',
			responseData: { numResults: 0, results: [] },
		});

		const [result] = await node.execute.call(makeContext());

		expect(result).toEqual([]);
	});

	it('returns no rows when the response has no responseData at all (defensive)', async () => {
		mockDriver.query.mockResolvedValue({ status: 'ok' });

		const [result] = await node.execute.call(makeContext());

		expect(result).toEqual([]);
	});

	it('runs one query per input item and concatenates the rows', async () => {
		mockDriver.query
			.mockResolvedValueOnce(selectResult([{ ID: 1 }]))
			.mockResolvedValueOnce(selectResult([{ ID: 2 }]));

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }] });
		const [result] = await node.execute.call(ctx);

		expect(mockDriver.query).toHaveBeenCalledTimes(2);
		expect(result[0].json).toEqual({ ID: 1 });
		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].json).toEqual({ ID: 2 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	// ── Return All / Limit (raw path) ───────────────────────────────────────────

	it('appends LIMIT when Return All is false', async () => {
		await node.execute.call(makeContext({ returnAll: false, limit: 10 }));

		expect(mockDriver.query).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" LIMIT 10',
			undefined,
			undefined,
			'raw',
		);
	});

	it('omits LIMIT when Return All is true, regardless of the Limit field', async () => {
		await node.execute.call(makeContext({ returnAll: true, limit: 10 }));

		expect(mockDriver.query).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE"',
			undefined,
			undefined,
			'raw',
		);
	});

	// A getNodeParameter(..., 'as number') cast has no effect at runtime — an n8n expression
	// can make Limit resolve to any value. It must be validated, not just cast, before being
	// concatenated into the query text.
	it('throws NodeOperationError instead of interpolating a non-numeric Limit into the query', async () => {
		const ctx = makeContext({ returnAll: false, limit: '10; DROP SCHEMA X CASCADE; --' });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Limit must be a positive integer');
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it.each([0, -1, 1.5])('rejects a Limit of %p as not a positive integer', async (limit) => {
		const ctx = makeContext({ returnAll: false, limit });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Limit must be a positive integer');
	});

	// ── WHERE conditions — parameterized path (prepare + stmt.execute) ─────────────

	it('builds a parameterized WHERE clause and binds its values via prepare()', async () => {
		const ctx = makeContext({
			where: { conditions: [{ column: 'ID', operator: 'equals', value: 42 }] },
		});
		await node.execute.call(ctx);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" WHERE "ID" = ?',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith(42);
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it('combines multiple WHERE conditions with the selected combinator', async () => {
		const ctx = makeContext({
			combineConditions: 'OR',
			where: {
				conditions: [
					{ column: 'A', operator: 'equals', value: 1 },
					{ column: 'B', operator: 'like', value: '%x%' },
				],
			},
		});
		await node.execute.call(ctx);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" WHERE "A" = ? OR "B" LIKE ?',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith(1, '%x%');
	});

	// IS NULL / IS NOT NULL bind no value, so a Where row using only those operators has zero
	// params — same as no Where at all — and must take the raw path, not prepare().
	it('takes the raw path for IS NULL / IS NOT NULL, since they bind no value', async () => {
		mockDriver.query.mockResolvedValue(selectResult([]));

		const ctx = makeContext({
			where: { conditions: [{ column: 'NAME', operator: 'isNull' }] },
		});
		await node.execute.call(ctx);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" WHERE "NAME" IS NULL',
			undefined,
			undefined,
			'raw',
		);
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	// combineConditions is joined straight into the WHERE clause text — like Limit, an
	// n8n-expression-driven value bypassing its 'AND' | 'OR' type must be rejected, not used.
	it('throws NodeOperationError instead of interpolating an invalid Combine Conditions value', async () => {
		const ctx = makeContext({
			combineConditions: '1=1; DROP SCHEMA X CASCADE; --',
			where: {
				conditions: [
					{ column: 'A', operator: 'equals', value: 1 },
					{ column: 'B', operator: 'equals', value: 2 },
				],
			},
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Invalid Where combinator');
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError for a WHERE operator outside the known allow-list', async () => {
		const ctx = makeContext({
			where: { conditions: [{ column: 'A', operator: '1=1 OR "A" = ?', value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Invalid Where operator');
	});

	it('takes the parameterized path when IS NULL is combined with a bound condition', async () => {
		const ctx = makeContext({
			where: {
				conditions: [
					{ column: 'NAME', operator: 'isNull' },
					{ column: 'ID', operator: 'equals', value: 1 },
				],
			},
		});
		await node.execute.call(ctx);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" WHERE "NAME" IS NULL AND "ID" = ?',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith(1);
	});

	// ── Sort (raw path) ─────────────────────────────────────────────────────────

	it('appends ORDER BY for a single sort rule', async () => {
		await node.execute.call(
			makeContext({ sort: { rules: [{ column: 'NAME', direction: 'DESC' }] } }),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" ORDER BY "NAME" DESC',
			undefined,
			undefined,
			'raw',
		);
	});

	it('appends ORDER BY with multiple rules in priority order', async () => {
		await node.execute.call(
			makeContext({
				sort: {
					rules: [
						{ column: 'A', direction: 'ASC' },
						{ column: 'B', direction: 'DESC' },
					],
				},
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" ORDER BY "A" ASC, "B" DESC',
			undefined,
			undefined,
			'raw',
		);
	});

	// Sort direction is a raw SQL keyword, not an identifier or a bindable value — an n8n
	// expression resolving to something other than 'ASC'/'DESC' must be rejected, not
	// concatenated into the ORDER BY clause as-is.
	it('throws NodeOperationError instead of interpolating an invalid Sort direction', async () => {
		const ctx = makeContext({
			sort: { rules: [{ column: 'NAME', direction: '"NAME"; DROP SCHEMA X CASCADE; --' }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Invalid Sort direction');
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it('combines WHERE, ORDER BY, and LIMIT in the correct clause order', async () => {
		await node.execute.call(
			makeContext({
				where: { conditions: [{ column: 'ID', operator: 'greaterThan', value: 0 }] },
				sort: { rules: [{ column: 'ID', direction: 'ASC' }] },
				returnAll: false,
				limit: 5,
			}),
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'SELECT * FROM "MY_SCHEMA"."MY_TABLE" WHERE "ID" > ? ORDER BY "ID" ASC LIMIT 5',
		);
	});

	// ── Statement / connection lifecycle ────────────────────────────────────────

	it('closes the prepared statement after execution on the parameterized path', async () => {
		await node.execute.call(
			makeContext({ where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] } }),
		);

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('closes the prepared statement even when execution fails on the parameterized path', async () => {
		mockStatement.execute.mockRejectedValue(new Error('boom'));

		await expect(
			node.execute.call(
				makeContext({ where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] } }),
			),
		).rejects.toThrow();

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('never calls prepare() on the raw path', async () => {
		await node.execute.call(makeContext());

		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	// ── Error handling — raw path ───────────────────────────────────────────────

	it('throws NodeOperationError when the driver reports status: error (raw path)', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-1', text: 'table not found' },
		});

		await expect(node.execute.call(makeContext())).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('uses a fallback message when the error response has no exception details', async () => {
		mockDriver.query.mockResolvedValue({ status: 'error', exception: undefined });

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ error: 'Select query failed' });
	});

	it('stores the error in json when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad query'));

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ error: 'bad query' });
	});

	it('sets pairedItem on error output when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad query'));

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }], continueOnFail: true });
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('throws NodeOperationError when continueOnFail is false', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad query'));

		await expect(node.execute.call(makeContext({ continueOnFail: false }))).rejects.toBeInstanceOf(
			NodeOperationError,
		);
	});

	// ── Error handling — parameterized path ─────────────────────────────────────

	it('throws NodeOperationError when the driver reports status: error (parameterized path)', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-1', text: 'type mismatch' },
		});

		await expect(
			node.execute.call(
				makeContext({ where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] } }),
			),
		).rejects.toBeInstanceOf(NodeOperationError);
	});

	// ── Validation ───────────────────────────────────────────────────────────────

	it('throws NodeOperationError for an empty Schema without wrapping it a second time', async () => {
		const ctx = makeContext({ schema: '' });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Schema must not be empty');
		expect(mockDriver.query).not.toHaveBeenCalled();
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError for an empty Table', async () => {
		const ctx = makeContext({ table: '' });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Table must not be empty');
	});

	it('stores an empty-Schema error in json when continueOnFail is true', async () => {
		const ctx = makeContext({ schema: '', continueOnFail: true });

		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toMatchObject({ error: expect.stringContaining('Schema must not be empty') });
	});

	it('continues processing later items after an earlier one fails with continueOnFail', async () => {
		mockDriver.query
			.mockRejectedValueOnce(new Error('first fails'))
			.mockResolvedValueOnce(selectResult([{ ID: 2 }]));

		const ctx = makeContext({
			items: [{ json: {} }, { json: {} }],
			continueOnFail: true,
		});
		const [result] = await node.execute.call(ctx);

		expect(result[0].json).toEqual({ error: 'first fails' });
		expect(result[1].json).toEqual({ ID: 2 });
	});
});
