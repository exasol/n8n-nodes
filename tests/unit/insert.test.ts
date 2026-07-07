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

// Builds the SQLResponse<SQLQueriesResponse> shape returned by stmt.execute() for a
// rowCount-typed result (INSERT/UPDATE/DELETE have no result set to return).
function rowCountResult(rowCount: number) {
	return {
		status: 'ok',
		responseData: {
			numResults: 1,
			results: [{ resultType: 'rowCount', rowCount }],
		},
	};
}

describe('Insert operation', () => {
	let node: Exasol;
	let mockDriver: MockDriver;
	let mockStatement: MockStatement;

	beforeEach(() => {
		node = new Exasol();
		mockStatement = {
			execute: jest.fn().mockResolvedValue(rowCountResult(0)),
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

	/**
	 * Builds a minimal IExecuteFunctions context wired to the "Insert" parameter shape.
	 * getNodeParameter dispatches by name, mirroring the fixedCollection shape n8n produces
	 * for "columns" ({ mappings: [...] }).
	 */
	type ColumnMappings = { mappings?: Array<{ column: unknown; value?: unknown }> };

	function makeContext(
		opts: {
			items?: INodeExecutionData[];
			schema?: string;
			table?: string;
			dataMode?: unknown;
			// A plain value applies to every item; a function receives the item index — mirrors
			// nodeTestHelper.ts's perItem() helper, needed to simulate a "Columns" mapping that
			// differs between items (e.g. one item's expression omitting a value).
			columns?: ColumnMappings | ((itemIndex: number) => ColumnMappings);
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
					if (name === 'operation') return 'insert';
					if (name === 'schema') return opts.schema ?? 'MY_SCHEMA';
					if (name === 'table') return opts.table ?? 'MY_TABLE';
					if (name === 'dataMode') return opts.dataMode ?? fallback ?? 'autoMapInputData';
					if (name === 'columns') {
						if (typeof opts.columns === 'function') return opts.columns(itemIndex ?? 0);
						return opts.columns ?? fallback ?? {};
					}
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	// ── Auto-Map Input Data ─────────────────────────────────────────────────────

	it('builds a single-row INSERT from the first item JSON keys (autoMapInputData)', async () => {
		mockStatement.execute.mockResolvedValue(rowCountResult(1));

		const [result] = await node.execute.call(
			makeContext({ items: [{ json: { ID: 1, NAME: 'a' } }] }),
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'INSERT INTO "MY_SCHEMA"."MY_TABLE" ("ID", "NAME") VALUES (?, ?)',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith(1, 'a');
		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
	});

	it('batches multiple items into one INSERT with one VALUES tuple per item', async () => {
		mockStatement.execute.mockResolvedValue(rowCountResult(3));

		const [result] = await node.execute.call(
			makeContext({
				items: [
					{ json: { ID: 1, NAME: 'a' } },
					{ json: { ID: 2, NAME: 'b' } },
					{ json: { ID: 3, NAME: 'c' } },
				],
			}),
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'INSERT INTO "MY_SCHEMA"."MY_TABLE" ("ID", "NAME") VALUES (?, ?), (?, ?), (?, ?)',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith(1, 'a', 2, 'b', 3, 'c');
		expect(mockDriver.prepare).toHaveBeenCalledTimes(1);
		expect(result).toEqual([{ json: { affectedRows: 3 }, pairedItem: [{ item: 0 }, { item: 1 }, { item: 2 }] }]);
	});

	it('uses only the first item to determine the column list, and null for a later item missing a key', async () => {
		await node.execute.call(
			makeContext({
				items: [{ json: { ID: 1, NAME: 'a' } }, { json: { ID: 2 } }],
			}),
		);

		expect(mockStatement.execute).toHaveBeenCalledWith(1, 'a', 2, null);
	});

	// ── Map Each Column Below (defineBelow) ─────────────────────────────────────

	it('builds an INSERT from the Columns collection (defineBelow)', async () => {
		mockStatement.execute.mockResolvedValue(rowCountResult(1));

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

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'INSERT INTO "MY_SCHEMA"."MY_TABLE" ("ID", "NAME") VALUES (?, ?)',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith(42, 'z');
		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
	});

	it('throws NodeOperationError for an empty column name in the Columns collection', async () => {
		const ctx = makeContext({
			dataMode: 'defineBelow',
			columns: { mappings: [{ column: '', value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Column name must not be empty');
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	// column?.trim() short-circuits on undefined without calling .trim() — distinct from the ''
	// case above, which does call .trim(). An n8n expression resolving Column to a non-string
	// exercises this path at runtime even though the UI type says string.
	it('throws NodeOperationError for an undefined column name in the Columns collection', async () => {
		const ctx = makeContext({
			dataMode: 'defineBelow',
			columns: { mappings: [{ column: undefined, value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Column name must not be empty');
	});

	// A truthy non-string Column (e.g. a number from an expression) passes `column?.trim` being
	// truthy-checked via `?.` alone, since `?.` only guards null/undefined — must still be caught.
	it('throws NodeOperationError for a numeric column name in the Columns collection', async () => {
		const ctx = makeContext({
			dataMode: 'defineBelow',
			columns: { mappings: [{ column: 42, value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Column name must not be empty');
	});

	it('uses null for a later item whose Columns mapping omits a column present in item 0 (defineBelow)', async () => {
		const columnsByItem: ColumnMappings[] = [
			{ mappings: [{ column: 'ID', value: 1 }, { column: 'NAME', value: 'a' }] },
			{ mappings: [{ column: 'ID', value: 2 }] },
		];
		await node.execute.call(
			makeContext({
				dataMode: 'defineBelow',
				items: [{ json: {} }, { json: {} }],
				columns: (itemIndex) => columnsByItem[itemIndex],
			}),
		);

		expect(mockStatement.execute).toHaveBeenCalledWith(1, 'a', 2, null);
	});

	// The column list is fixed from item 0; if a later item's own Column-name field resolves (e.g.
	// via expression) to a name outside that list, silently dropping the value as null would lose
	// data with no indication in the result — this must fail loudly instead.
	it('throws NodeOperationError when a later item maps a column name not present in item 0 (defineBelow)', async () => {
		const columnsByItem: ColumnMappings[] = [
			{ mappings: [{ column: 'ID', value: 1 }, { column: 'NAME', value: 'a' }] },
			{ mappings: [{ column: 'ID', value: 2 }, { column: 'NAAME', value: 'typo' }] },
		];
		const ctx = makeContext({
			dataMode: 'defineBelow',
			items: [{ json: {} }, { json: {} }],
			columns: (itemIndex) => columnsByItem[itemIndex],
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Item 1 maps column(s)');
		expect((thrown as NodeOperationError).message).toContain('NAAME');
		expect(mockStatement.execute).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError when the Columns collection is empty (defineBelow)', async () => {
		const ctx = makeContext({ dataMode: 'defineBelow', columns: {} });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('No columns to insert');
	});

	it('throws NodeOperationError when the first item has no JSON keys (autoMapInputData)', async () => {
		const ctx = makeContext({ items: [{ json: {} }] });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('No columns to insert');
	});

	// ── Empty input ──────────────────────────────────────────────────────────────

	it('returns an empty array and never queries the driver when there are no input items', async () => {
		const [result] = await node.execute.call(makeContext({ items: [] }));

		expect(result).toEqual([]);
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	// ── Statement lifecycle ──────────────────────────────────────────────────────

	it('closes the prepared statement after execution', async () => {
		await node.execute.call(makeContext());

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	it('closes the prepared statement even when execution fails', async () => {
		mockStatement.execute.mockRejectedValue(new Error('boom'));

		await expect(node.execute.call(makeContext())).rejects.toThrow();

		expect(mockStatement.close).toHaveBeenCalledTimes(1);
	});

	// ── Error handling ───────────────────────────────────────────────────────────

	it('throws NodeOperationError when the driver reports status: error', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'error',
			exception: { sqlCode: 'E-1', text: 'not a table' },
		});

		await expect(node.execute.call(makeContext())).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('uses a fallback message when the error response has no exception details', async () => {
		mockStatement.execute.mockResolvedValue({ status: 'error', exception: undefined });

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({
			error: 'Insert failed (query: INSERT INTO "MY_SCHEMA"."MY_TABLE" ("ID", "NAME") VALUES (?, ?))',
		});
	});

	it('defaults affectedRows to 0 when the response has no rowCount', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			responseData: { numResults: 1, results: [{ resultType: 'rowCount' }] },
		});

		const [result] = await node.execute.call(makeContext());

		expect(result).toEqual([{ json: { affectedRows: 0 }, pairedItem: [{ item: 0 }] }]);
	});

	it('includes the executed SQL query in the error message', async () => {
		mockStatement.execute.mockRejectedValue(new Error('connection reset'));

		const ctx = makeContext({ schema: 'S', table: 'T', continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({
			error: 'connection reset (query: INSERT INTO "S"."T" ("ID", "NAME") VALUES (?, ?))',
		});
	});

	it('returns one error item with pairedItem for every input item when continueOnFail is true', async () => {
		mockStatement.execute.mockRejectedValue(new Error('bad insert'));

		const ctx = makeContext({
			items: [{ json: { ID: 1 } }, { json: { ID: 2 } }],
			continueOnFail: true,
		});
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(1);
		expect(result[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
		expect(result[0].json).toMatchObject({ error: expect.stringContaining('bad insert') });
	});

	it('throws NodeOperationError when continueOnFail is false', async () => {
		mockStatement.execute.mockRejectedValue(new Error('bad insert'));

		await expect(node.execute.call(makeContext({ continueOnFail: false }))).rejects.toBeInstanceOf(
			NodeOperationError,
		);
	});

	// ── Validation ───────────────────────────────────────────────────────────────

	it('throws NodeOperationError for an empty Schema without wrapping it a second time', async () => {
		const ctx = makeContext({ schema: '' });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Schema must not be empty');
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError for an empty Table', async () => {
		const ctx = makeContext({ table: '' });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Table must not be empty');
	});

	it('trims surrounding whitespace from Schema and Table before quoting them', async () => {
		await node.execute.call(makeContext({ schema: '  MY_SCHEMA  ', table: '  MY_TABLE  ' }));

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'INSERT INTO "MY_SCHEMA"."MY_TABLE" ("ID", "NAME") VALUES (?, ?)',
		);
	});

	it('stores an empty-Schema error in json when continueOnFail is true', async () => {
		const ctx = makeContext({ schema: '', continueOnFail: true });

		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toMatchObject({ error: expect.stringContaining('Schema must not be empty') });
	});
});
