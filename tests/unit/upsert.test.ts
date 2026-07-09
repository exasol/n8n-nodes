import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

// Must be imported before Exasol.node below: this module calls jest.mock('@exasol/exasol-driver-ts'),
// which only replaces the driver for modules required afterwards in this file's require order.
import { rowCountResult, setupMockDriver, type MockDriver } from './testHelpers/mockDriver';
import { itValidatesSchemaAndTable } from './testHelpers/schemaTableValidation';
import { Exasol } from '../../nodes/Exasol/Exasol.node';

describe('Upsert operation', () => {
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

	/**
	 * Builds a minimal IExecuteFunctions context wired to the "Upsert" parameter shape.
	 * getNodeParameter dispatches by name, mirroring the fixedCollection shape n8n produces
	 * for "columns" ({ mappings: [...] }) and the plain string[] it produces for a
	 * multipleValues string field ("conflictColumns").
	 */
	type ColumnMappings = { mappings?: Array<{ column: unknown; value?: unknown }> };

	function makeContext(
		opts: {
			items?: INodeExecutionData[];
			schema?: string;
			table?: string;
			dataMode?: unknown;
			columns?: ColumnMappings | ((itemIndex: number) => ColumnMappings);
			conflictColumns?: unknown[];
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
			getInputData: jest.fn().mockReturnValue(opts.items ?? [{ json: { ID: 1, NAME: 'a' } }]),
			getNodeParameter: jest
				.fn()
				.mockImplementation((name: string, itemIndex?: number, fallback?: unknown) => {
					if (name === 'operation') return 'upsert';
					if (name === 'schema') return opts.schema ?? 'MY_SCHEMA';
					if (name === 'table') return opts.table ?? 'MY_TABLE';
					if (name === 'dataMode') return opts.dataMode ?? fallback ?? 'autoMapInputData';
					if (name === 'columns') {
						if (typeof opts.columns === 'function') return opts.columns(itemIndex ?? 0);
						return opts.columns ?? fallback ?? {};
					}
					// Unlike the other parameters here, the default below intentionally ignores
					// `fallback`: the real getNodeParameter call passes [] as its fallback, which is
					// not nullish, so `fallback ?? ['ID']` would never reach the ['ID'] default most
					// tests want (mirrors the identical `where` default in update.test.ts).
					if (name === 'conflictColumns') return opts.conflictColumns ?? ['ID'];
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	// ── Auto-Map Input Data ─────────────────────────────────────────────────────

	it('builds a single-row MERGE from the first item JSON keys (autoMapInputData), values inlined', async () => {
		mockDriver.query.mockResolvedValue(rowCountResult(1));

		const [result] = await node.execute.call(
			makeContext({ items: [{ json: { ID: 1, NAME: 'a' } }] }),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			'MERGE INTO "MY_SCHEMA"."MY_TABLE" target\n' +
				'USING (\n' +
				"  VALUES (1, 'a')\n" +
				') src("ID", "NAME")\n' +
				'ON target."ID" = src."ID"\n' +
				'WHEN MATCHED THEN\n' +
				'  UPDATE SET target."NAME" = src."NAME"\n' +
				'WHEN NOT MATCHED THEN\n' +
				'  INSERT ("ID", "NAME") VALUES (src."ID", src."NAME")',
			undefined,
			undefined,
			'raw',
		);
		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
	});

	it('batches multiple items into one MERGE with one source row per item', async () => {
		mockDriver.query.mockResolvedValue(rowCountResult(3));

		const [result] = await node.execute.call(
			makeContext({
				items: [
					{ json: { ID: 1, NAME: 'a' } },
					{ json: { ID: 2, NAME: 'b' } },
					{ json: { ID: 3, NAME: 'c' } },
				],
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledTimes(1);
		expect(mockDriver.query).toHaveBeenCalledWith(
			expect.stringContaining("VALUES (1, 'a'),\n         (2, 'b'),\n         (3, 'c')"),
			undefined,
			undefined,
			'raw',
		);
		expect(result).toEqual([
			{ json: { affectedRows: 3 }, pairedItem: [{ item: 0 }, { item: 1 }, { item: 2 }] },
		]);
	});

	it('uses only the first item to determine the column list, and null for a later item missing a key', async () => {
		await node.execute.call(
			makeContext({
				items: [{ json: { ID: 1, NAME: 'a' } }, { json: { ID: 2 } }],
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			expect.stringContaining("VALUES (1, 'a'),\n         (2, NULL)"),
			undefined,
			undefined,
			'raw',
		);
	});

	// ── Map Each Column Below (defineBelow) ─────────────────────────────────────

	it('builds a MERGE from the Columns collection (defineBelow)', async () => {
		mockDriver.query.mockResolvedValue(rowCountResult(1));

		const [result] = await node.execute.call(
			makeContext({
				dataMode: 'defineBelow',
				columns: {
					mappings: [
						{ column: 'ID', value: 42 },
						{ column: 'NAME', value: 'z' },
					],
				},
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			expect.stringContaining("VALUES (42, 'z')"),
			undefined,
			undefined,
			'raw',
		);
		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
	});

	it('throws NodeOperationError for an empty column name in the Columns collection', async () => {
		const ctx = makeContext({
			dataMode: 'defineBelow',
			columns: { mappings: [{ column: '', value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Column name must be a non-empty string.');
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError when the Columns collection is empty (defineBelow)', async () => {
		const ctx = makeContext({ dataMode: 'defineBelow', columns: {} });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('No columns to upsert');
	});

	it('throws NodeOperationError when the first item has no JSON keys (autoMapInputData)', async () => {
		const ctx = makeContext({ items: [{ json: {} }] });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('No columns to upsert');
	});

	// ── Conflict Columns ─────────────────────────────────────────────────────────

	it('supports multiple conflict columns, ANDed in the ON clause', async () => {
		await node.execute.call(
			makeContext({
				items: [{ json: { TENANT_ID: 1, ID: 2, NAME: 'a' } }],
				conflictColumns: ['TENANT_ID', 'ID'],
			}),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			expect.stringContaining('ON target."TENANT_ID" = src."TENANT_ID" AND target."ID" = src."ID"'),
			undefined,
			undefined,
			'raw',
		);
	});

	it('sets every non-conflict column on a match', async () => {
		await node.execute.call(
			makeContext({ items: [{ json: { ID: 1, NAME: 'a', ALTITUDE: 100 } }] }),
		);

		expect(mockDriver.query).toHaveBeenCalledWith(
			expect.stringContaining(
				'UPDATE SET target."NAME" = src."NAME", target."ALTITUDE" = src."ALTITUDE"',
			),
			undefined,
			undefined,
			'raw',
		);
	});

	it('throws NodeOperationError when Conflict Columns is empty, without touching the driver', async () => {
		const ctx = makeContext({ conflictColumns: [] });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			'At least one Conflict Column is required',
		);
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError when an item has a NULL value in a Conflict Column, without touching the driver', async () => {
		const ctx = makeContext({ items: [{ json: { ID: null, NAME: 'a' } }] });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			'Row 0 has no value for Conflict Column "ID"',
		);
		expect(mockDriver.query).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError when a Conflict Column is not one of the mapped columns', async () => {
		const ctx = makeContext({ conflictColumns: ['NOPE'] });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			'Conflict Column(s) not present in the mapped columns',
		);
	});

	// ── Empty input ──────────────────────────────────────────────────────────────

	it('returns an empty array and never queries the driver when there are no input items', async () => {
		const [result] = await node.execute.call(makeContext({ items: [] }));

		expect(result).toEqual([]);
		expect(mockDriver.query).not.toHaveBeenCalled();
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

		expect(item.json).toMatchObject({
			error: expect.stringContaining('Upsert failed (query: MERGE INTO "MY_SCHEMA"."MY_TABLE" target'),
		});
	});

	it('defaults affectedRows to 0 when the response has no rowCount', async () => {
		mockDriver.query.mockResolvedValue({
			status: 'ok',
			responseData: { numResults: 1, results: [{ resultType: 'rowCount' }] },
		});

		const [result] = await node.execute.call(makeContext());

		expect(result).toEqual([{ json: { affectedRows: 0 }, pairedItem: [{ item: 0 }] }]);
	});

	it('includes the executed SQL query in the error message', async () => {
		mockDriver.query.mockRejectedValue(new Error('connection reset'));

		const ctx = makeContext({ schema: 'S', table: 'T', continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toMatchObject({
			error: expect.stringContaining('connection reset (query: MERGE INTO "S"."T" target'),
		});
	});

	it('returns one error item with pairedItem for every input item when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad upsert'));

		const ctx = makeContext({
			items: [{ json: { ID: 1, NAME: 'a' } }, { json: { ID: 2, NAME: 'b' } }],
			continueOnFail: true,
		});
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(1);
		expect(result[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
		expect(result[0].json).toMatchObject({ error: expect.stringContaining('bad upsert') });
	});

	it('throws NodeOperationError when continueOnFail is false', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad upsert'));

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
				expect.stringContaining('MERGE INTO "MY_SCHEMA"."MY_TABLE" target'),
				undefined,
				undefined,
				'raw',
			),
	});
});
