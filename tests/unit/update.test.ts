import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

// Must be imported before Exasol.node below: this module calls jest.mock('@exasol/exasol-driver-ts'),
// which only replaces the driver for modules required afterwards in this file's require order.
import {
	rowCountResult,
	setupMockDriver,
	type MockDriver,
	type MockStatement,
} from './testHelpers/mockDriver';
import { Exasol } from '../../nodes/Exasol/Exasol.node';

describe('Update operation', () => {
	let node: Exasol;
	let mockDriver: MockDriver;
	let mockStatement: MockStatement;

	beforeEach(() => {
		node = new Exasol();
		({ mockDriver, mockStatement } = setupMockDriver());
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	type ColumnMappings = { mappings?: Array<{ column: unknown; value?: unknown }> };
	type WhereConditions = {
		conditions?: Array<{ column: string; operator: string; value?: unknown }>;
	};

	/**
	 * Builds a minimal IExecuteFunctions context wired to the "Update" parameter shape.
	 * getNodeParameter dispatches by name, mirroring the fixedCollection shapes n8n produces
	 * for "columns" ({ mappings: [...] }) and "where" ({ conditions: [...] }). A plain value
	 * applies to every item; a function receives the item index — mirrors nodeTestHelper.ts's
	 * perItem() helper, needed since Update reads its SET/WHERE parameters independently per item.
	 */
	function makeContext(
		opts: {
			items?: INodeExecutionData[];
			schema?: string;
			table?: string;
			dataMode?: unknown;
			columns?: ColumnMappings | ((itemIndex: number) => ColumnMappings);
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
			getInputData: jest.fn().mockReturnValue(opts.items ?? [{ json: { NAME: 'a' } }]),
			getNodeParameter: jest
				.fn()
				.mockImplementation((name: string, itemIndex?: number, fallback?: unknown) => {
					if (name === 'operation') return 'update';
					if (name === 'schema') return opts.schema ?? 'MY_SCHEMA';
					if (name === 'table') return opts.table ?? 'MY_TABLE';
					if (name === 'dataMode') return opts.dataMode ?? fallback ?? 'autoMapInputData';
					if (name === 'columns') {
						if (typeof opts.columns === 'function') return opts.columns(itemIndex ?? 0);
						return opts.columns ?? fallback ?? {};
					}
					if (name === 'combineConditions') return opts.combineConditions ?? fallback ?? 'AND';
					if (name === 'where') {
						if (typeof opts.where === 'function') return opts.where(itemIndex ?? 0);
						// Unlike the other parameters here, the default below intentionally ignores
						// `fallback` (always {} from readWhereConditions's own getNodeParameter call):
						// most tests want a non-empty Where by default so they don't all have to pass
						// one just to get past the "Where is required" guard.
						return (
							opts.where ?? { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] }
						);
					}
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	// ── Auto-Map Input Data ─────────────────────────────────────────────────────

	it('builds an UPDATE from the item JSON keys (autoMapInputData)', async () => {
		mockStatement.execute.mockResolvedValue(rowCountResult(1));

		const [result] = await node.execute.call(
			makeContext({
				items: [{ json: { NAME: 'a' } }],
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] },
			}),
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ? WHERE "ID" = ?',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith('a', 1);
		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: { item: 0 } }]);
	});

	it('runs one UPDATE per input item, with independent SET values and WHERE conditions', async () => {
		mockStatement.execute.mockResolvedValue(rowCountResult(1));

		const itemsWhere: WhereConditions[] = [
			{ conditions: [{ column: 'ID', operator: 'equals', value: 1 }] },
			{ conditions: [{ column: 'ID', operator: 'equals', value: 2 }] },
		];
		const [result] = await node.execute.call(
			makeContext({
				items: [{ json: { NAME: 'a' } }, { json: { NAME: 'b' } }],
				where: (itemIndex) => itemsWhere[itemIndex],
			}),
		);

		expect(mockDriver.prepare).toHaveBeenCalledTimes(2);
		expect(mockDriver.prepare).toHaveBeenNthCalledWith(
			1,
			'UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ? WHERE "ID" = ?',
		);
		expect(mockStatement.execute).toHaveBeenNthCalledWith(1, 'a', 1);
		expect(mockStatement.execute).toHaveBeenNthCalledWith(2, 'b', 2);
		expect(result).toEqual([
			{ json: { affectedRows: 1 }, pairedItem: { item: 0 } },
			{ json: { affectedRows: 1 }, pairedItem: { item: 1 } },
		]);
	});

	it('converts a null JSON value to a bound null rather than undefined', async () => {
		await node.execute.call(makeContext({ items: [{ json: { NAME: null } }] }));

		expect(mockStatement.execute).toHaveBeenCalledWith(null, 1);
	});

	// ── Map Each Column Below (defineBelow) ─────────────────────────────────────

	it('builds an UPDATE from the Columns collection (defineBelow)', async () => {
		mockStatement.execute.mockResolvedValue(rowCountResult(1));

		const [result] = await node.execute.call(
			makeContext({
				dataMode: 'defineBelow',
				columns: { mappings: [{ column: 'NAME', value: 'z' }] },
			}),
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ? WHERE "ID" = ?',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith('z', 1);
		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: { item: 0 } }]);
	});

	it('binds multiple mapped columns in the order given', async () => {
		await node.execute.call(
			makeContext({
				dataMode: 'defineBelow',
				columns: {
					mappings: [
						{ column: 'NAME', value: 'z' },
						{ column: 'ALTITUDE', value: 100 },
					],
				},
			}),
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ?, "ALTITUDE" = ? WHERE "ID" = ?',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith('z', 100, 1);
	});

	it('uses null for a mapping row with no Value set (defineBelow)', async () => {
		await node.execute.call(
			makeContext({
				dataMode: 'defineBelow',
				columns: { mappings: [{ column: 'NAME' }] },
			}),
		);

		expect(mockStatement.execute).toHaveBeenCalledWith(null, 1);
	});

	it('throws NodeOperationError for an empty column name in the Columns collection', async () => {
		const ctx = makeContext({
			dataMode: 'defineBelow',
			columns: { mappings: [{ column: '', value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			'Column name must be a non-empty string.',
		);
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	it('throws NodeOperationError for an undefined column name in the Columns collection', async () => {
		const ctx = makeContext({
			dataMode: 'defineBelow',
			columns: { mappings: [{ column: undefined, value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			'Column name must be a non-empty string.',
		);
	});

	it('throws NodeOperationError for a numeric column name in the Columns collection', async () => {
		const ctx = makeContext({
			dataMode: 'defineBelow',
			columns: { mappings: [{ column: 42, value: 1 }] },
		});

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			'Column name must be a non-empty string.',
		);
	});

	it('throws NodeOperationError when the Columns collection is empty (defineBelow)', async () => {
		const ctx = makeContext({ dataMode: 'defineBelow', columns: {} });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('No columns to update');
	});

	it('throws NodeOperationError when the item has no JSON keys (autoMapInputData)', async () => {
		const ctx = makeContext({ items: [{ json: {} }] });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('No columns to update');
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

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ? WHERE "A" = ? OR "B" LIKE ?',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith('a', 1, '%x%');
	});

	it('supports IS NULL, which binds no value', async () => {
		await node.execute.call(
			makeContext({ where: { conditions: [{ column: 'NAME', operator: 'isNull' }] } }),
		);

		expect(mockDriver.prepare).toHaveBeenCalledWith(
			'UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ? WHERE "NAME" IS NULL',
		);
		expect(mockStatement.execute).toHaveBeenCalledWith('a');
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

	// ── Empty WHERE guard ────────────────────────────────────────────────────────

	it('throws NodeOperationError when Where has no conditions, without touching the driver', async () => {
		const ctx = makeContext({ where: {} });

		const thrown = await node.execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Where conditions are required');
		expect(mockDriver.prepare).not.toHaveBeenCalled();
	});

	it('stores the empty-Where error in json when continueOnFail is true', async () => {
		const ctx = makeContext({ where: {}, continueOnFail: true });

		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toMatchObject({
			error: expect.stringContaining('Where conditions are required'),
		});
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
			error: 'Update failed (query: UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ? WHERE "ID" = ?)',
		});
	});

	it('defaults affectedRows to 0 when the response has no rowCount', async () => {
		mockStatement.execute.mockResolvedValue({
			status: 'ok',
			responseData: { numResults: 1, results: [{ resultType: 'rowCount' }] },
		});

		const [result] = await node.execute.call(makeContext());

		expect(result).toEqual([{ json: { affectedRows: 0 }, pairedItem: { item: 0 } }]);
	});

	it('includes the executed SQL query in the error message', async () => {
		mockStatement.execute.mockRejectedValue(new Error('connection reset'));

		const ctx = makeContext({ schema: 'S', table: 'T', continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({
			error: 'connection reset (query: UPDATE "S"."T" SET "NAME" = ? WHERE "ID" = ?)',
		});
	});

	it('continues processing later items after an earlier one fails with continueOnFail', async () => {
		mockStatement.execute
			.mockRejectedValueOnce(new Error('first fails'))
			.mockResolvedValueOnce(rowCountResult(1));

		const ctx = makeContext({
			items: [{ json: { NAME: 'a' } }, { json: { NAME: 'b' } }],
			continueOnFail: true,
		});
		const [result] = await node.execute.call(ctx);

		expect(result[0].json).toMatchObject({ error: expect.stringContaining('first fails') });
		expect(result[1].json).toEqual({ affectedRows: 1 });
	});

	it('sets pairedItem on error output when continueOnFail is true', async () => {
		mockStatement.execute.mockRejectedValue(new Error('bad update'));

		const ctx = makeContext({
			items: [{ json: { NAME: 'a' } }, { json: { NAME: 'b' } }],
			continueOnFail: true,
		});
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('throws NodeOperationError when continueOnFail is false', async () => {
		mockStatement.execute.mockRejectedValue(new Error('bad update'));

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
			'UPDATE "MY_SCHEMA"."MY_TABLE" SET "NAME" = ? WHERE "ID" = ?',
		);
	});

	it('stores an empty-Schema error in json when continueOnFail is true', async () => {
		const ctx = makeContext({ schema: '', continueOnFail: true });

		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toMatchObject({ error: expect.stringContaining('Schema must not be empty') });
	});
});
