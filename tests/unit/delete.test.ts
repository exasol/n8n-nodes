import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

// Must be imported before Exasol.node below: this module calls jest.mock('@exasol/exasol-driver-ts'),
// which only replaces the driver for modules required afterwards in this file's require order.
import { rowCountResult, setupMockDriver, type MockDriver } from './testHelpers/mockDriver';
import { itValidatesSchemaAndTable } from './testHelpers/schemaTableValidation';
import { Exasol } from '../../nodes/Exasol/Exasol.node';

describe('Delete operation', () => {
	let node: Exasol;
	let mockDriver: MockDriver;

	beforeEach(() => {
		node = new Exasol();
		({ mockDriver } = setupMockDriver());
		mockDriver.query.mockResolvedValue(rowCountResult(0));
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	type WhereConditions = {
		conditions?: Array<{ column: string; operator: string; value?: unknown }>;
	};

	/**
	 * Builds a minimal IExecuteFunctions context wired to the "Delete" parameter shape.
	 * getNodeParameter dispatches by name, mirroring the fixedCollection shape n8n produces for
	 * "where" ({ conditions: [...] }). A plain value applies to every item; a function receives
	 * the item index — mirrors update.test.ts's makeContext(), needed since Delete reads its
	 * WHERE parameters independently per item.
	 */
	function makeContext(
		opts: {
			items?: INodeExecutionData[];
			schema?: string;
			table?: string;
			combineConditions?: unknown;
			where?: WhereConditions | ((itemIndex: number) => WhereConditions);
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
				.mockImplementation((name: string, itemIndex?: number, fallback?: unknown) => {
					if (name === 'operation') return 'delete';
					if (name === 'schema') return opts.schema ?? 'MY_SCHEMA';
					if (name === 'table') return opts.table ?? 'MY_TABLE';
					if (name === 'combineConditions') return opts.combineConditions ?? fallback ?? 'AND';
					if (name === 'where') {
						if (typeof opts.where === 'function') return opts.where(itemIndex ?? 0);
						// Unlike the other parameters here, the default below intentionally ignores
						// `fallback` (always {} from readWhereConditions's own getNodeParameter call):
						// most tests want a non-empty Where by default so they don't all have to pass
						// one just to get past the "Where is required" guard.
						return opts.where ?? { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] };
					}
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	// ── Basic DELETE ─────────────────────────────────────────────────────────────

	it('builds a DELETE with the configured WHERE conditions, values inlined as literals', async () => {
		mockDriver.query.mockResolvedValue(rowCountResult(1));

		const [result] = await node.execute.call(
			makeContext({ where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] } }),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "ID" = 1',
			undefined,
			undefined,
			'raw',
		);
		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: { item: 0 } }]);
	});

	it('runs one DELETE per input item, with independent WHERE conditions', async () => {
		mockDriver.query.mockResolvedValue(rowCountResult(1));

		const itemsWhere: WhereConditions[] = [
			{ conditions: [{ column: 'ID', operator: 'equals', value: 1 }] },
			{ conditions: [{ column: 'ID', operator: 'equals', value: 2 }] },
		];
		const [result] = await node.execute.call(
			makeContext({
				items: [{ json: {} }, { json: {} }],
				where: (itemIndex) => itemsWhere[itemIndex],
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledTimes(2);
		expect(mockDriver.query).toHaveBeenNthCalledWith(
			1,
			'DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "ID" = 1',
			undefined,
			undefined,
			'raw',
		);
		expect(mockDriver.query).toHaveBeenNthCalledWith(
			2,
			'DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "ID" = 2',
			undefined,
			undefined,
			'raw',
		);
		expect(result).toEqual([
			{ json: { affectedRows: 1 }, pairedItem: { item: 0 } },
			{ json: { affectedRows: 1 }, pairedItem: { item: 1 } },
		]);
	});

	// ── WHERE conditions ─────────────────────────────────────────────────────────

	it('combines multiple WHERE conditions with the selected combinator', async () => {
		await node.execute.call(
			makeContext({
				combineConditions: 'OR',
				where: {
					conditions: [
						{ column: 'A', operator: 'equals', value: 1 },
						{ column: 'B', operator: 'like', value: '%x%' },
					],
				},
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			`DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "A" = 1 OR "B" LIKE '%x%'`,
			undefined,
			undefined,
			'raw',
		);
	});

	it('supports IS NULL, which needs no value', async () => {
		await node.execute.call(
			makeContext({ where: { conditions: [{ column: 'NAME', operator: 'isNull' }] } }),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "NAME" IS NULL',
			undefined,
			undefined,
			'raw',
		);
	});

	it('escapes an embedded single quote in a string value', async () => {
		await node.execute.call(
			makeContext({
				where: { conditions: [{ column: 'NAME', operator: 'equals', value: "O'Brien" }] },
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			`DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "NAME" = 'O''Brien'`,
			undefined,
			undefined,
			'raw',
		);
	});

	it('renders a null value as the NULL literal', async () => {
		await node.execute.call(
			makeContext({
				where: { conditions: [{ column: 'NAME', operator: 'equals', value: null }] },
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "NAME" = NULL',
			undefined,
			undefined,
			'raw',
		);
	});

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
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError for a WHERE operator outside the known allow-list', async () => {
		const ctx = makeContext({
			where: { conditions: [{ column: 'A', operator: '1=1 OR "A" = ?', value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Invalid Where operator');
	});

	// ── Empty WHERE guard ────────────────────────────────────────────────────────

	it('throws NodeOperationError when Where has no conditions, without touching the driver', async () => {
		const ctx = makeContext({ where: {} });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Where conditions are required');
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it('stores the empty-Where error in json when continueOnFail is true', async () => {
		const ctx = makeContext({ where: {}, continueOnFail: true });

		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toMatchObject({
			error: expect.stringContaining('Where conditions are required'),
		});
	});

	// ── Error handling ───────────────────────────────────────────────────────────

	it('throws NodeOperationError when the driver reports status: error', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-1', text: 'not a table' },
		});

		await expect(node.execute.call(makeContext())).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('uses a fallback message when the error response has no exception details', async () => {
		mockDriver.query.mockResolvedValue({ status: 'error', exception: undefined });

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({
			error: 'Delete failed (query: DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "ID" = 1)',
		});
	});

	it('defaults affectedRows to 0 when the response has no rowCount', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'ok',
			responseData: { numResults: 1, results: [{ resultType: 'rowCount' }] },
		});

		const [result] = await node.execute.call(makeContext());

		expect(result).toEqual([{ json: { affectedRows: 0 }, pairedItem: { item: 0 } }]);
	});

	it('includes the executed SQL query in the error message', async () => {
		mockDriver.query.mockRejectedValue(new Error('connection reset'));

		const ctx = makeContext({ schema: 'S', table: 'T', continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({
			error: 'connection reset (query: DELETE FROM "S"."T" WHERE "ID" = 1)',
		});
	});

	it('continues processing later items after an earlier one fails with continueOnFail', async () => {
		mockDriver.query
			.mockRejectedValueOnce(new Error('first fails'))
			.mockResolvedValueOnce(rowCountResult(1));

		const ctx = makeContext({
			items: [{ json: {} }, { json: {} }],
			continueOnFail: true,
		});
		const [result] = await node.execute.call(ctx);

		expect(result[0].json).toMatchObject({ error: expect.stringContaining('first fails') });
		expect(result[1].json).toEqual({ affectedRows: 1 });
	});

	it('sets pairedItem on error output when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad delete'));

		const ctx = makeContext({
			items: [{ json: {} }, { json: {} }],
			continueOnFail: true,
		});
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('throws NodeOperationError when continueOnFail is false', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad delete'));

		await expect(node.execute.call(makeContext({ continueOnFail: false }))).rejects.toBeInstanceOf(
			NodeOperationError,
		);
	});

	// ── Validation ───────────────────────────────────────────────────────────────

	itValidatesSchemaAndTable({
		execute: (ctx) => node.execute.call(ctx),
		makeContext,
		assertNotExecuted: () => expect(mockDriver.query).not.toHaveBeenCalled(),
		assertTrimmedSqlExecuted: () =>
			expect(mockDriver.query).toHaveBeenCalledWith(
				'DELETE FROM "MY_SCHEMA"."MY_TABLE" WHERE "ID" = 1',
				undefined,
				undefined,
				'raw',
			),
	});
});
