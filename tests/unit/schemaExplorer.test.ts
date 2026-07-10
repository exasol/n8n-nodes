import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

// Must be imported before Exasol.node below: this module calls jest.mock('@exasol/exasol-driver-ts'),
// which only replaces the driver for modules required afterwards in this file's require order.
import { setupMockDriver, type MockDriver, type MockStatement } from './testHelpers/mockDriver';
import { Exasol } from '../../nodes/Exasol/Exasol.node';

// Builds the SQLResponse<SQLQueriesResponse> shape returned by both driver.query(..., 'raw')
// and stmt.execute() for a SELECT result. The Exasol wire format is column-major:
// data[colIdx][rowIdx]. This helper converts the friendlier row-major input so tests stay
// readable. Mirrors the identical helper in selectRows.test.ts.
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

const LIST_SCHEMAS_QUERY =
	'SELECT SCHEMA_NAME AS "name", SCHEMA_COMMENT AS "comment" FROM EXA_ALL_SCHEMAS ORDER BY SCHEMA_NAME';

const LIST_TABLES_QUERY =
	'SELECT TABLE_SCHEMA AS "schema", TABLE_NAME AS "name", TABLE_COMMENT AS "comment", \'TABLE\' AS "type" FROM EXA_ALL_TABLES WHERE TABLE_SCHEMA = ? ORDER BY "name"';

const LIST_TABLES_WITH_VIEWS_QUERY =
	'SELECT TABLE_SCHEMA AS "schema", TABLE_NAME AS "name", TABLE_COMMENT AS "comment", \'TABLE\' AS "type" FROM EXA_ALL_TABLES WHERE TABLE_SCHEMA = ? UNION ALL SELECT VIEW_SCHEMA AS "schema", VIEW_NAME AS "name", VIEW_COMMENT AS "comment", \'VIEW\' AS "type" FROM EXA_ALL_VIEWS WHERE VIEW_SCHEMA = ? ORDER BY "name"';

const DESCRIBE_TABLE_COLUMNS_QUERY =
	'SELECT COLUMN_NAME AS "name", COLUMN_TYPE AS "type", COLUMN_IS_NULLABLE AS "nullable", COLUMN_DEFAULT AS "default", COLUMN_COMMENT AS "comment" FROM EXA_ALL_COLUMNS WHERE COLUMN_SCHEMA = ? AND COLUMN_TABLE = ? ORDER BY COLUMN_ORDINAL_POSITION';

const DESCRIBE_TABLE_CONSTRAINTS_QUERY =
	'SELECT CONSTRAINT_TYPE AS "type", CONSTRAINT_NAME AS "name", COLUMN_NAME AS "columnName", REFERENCED_SCHEMA AS "referencedSchema", REFERENCED_TABLE AS "referencedTable", REFERENCED_COLUMN AS "referencedColumn" FROM EXA_ALL_CONSTRAINT_COLUMNS WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_TABLE = ? ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION';

describe('Schema Explorer operations', () => {
	let node: Exasol;
	let mockDriver: MockDriver;
	let mockStatement: MockStatement;

	beforeEach(() => {
		node = new Exasol();
		({ mockDriver, mockStatement } = setupMockDriver());
		mockStatement.execute.mockResolvedValue(selectResult([]));
		mockDriver.query.mockResolvedValue(selectResult([]));
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	/**
	 * Builds a minimal IExecuteFunctions context wired to the Schema Explorer parameter shape.
	 * getNodeParameter dispatches by name, same convention as selectRows.test.ts's makeContext.
	 */
	function makeContext(
		opts: {
			operation?: 'listSchemas' | 'listTables' | 'describeTable';
			items?: INodeExecutionData[];
			schema?: string;
			table?: string;
			includeViews?: boolean;
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
					if (name === 'operation') return opts.operation ?? 'listSchemas';
					if (name === 'schema') return opts.schema ?? 'MY_SCHEMA';
					if (name === 'table') return opts.table ?? 'MY_TABLE';
					if (name === 'includeViews') return opts.includeViews ?? fallback ?? false;
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
			addExecutionHints: jest.fn(),
		} as unknown as IExecuteFunctions;
	}

	// ── List Schemas ─────────────────────────────────────────────────────────────

	describe('List Schemas', () => {
		it('runs the raw (parameter-free) query and maps rows to items', async () => {
			mockDriver.query.mockResolvedValue(
				selectResult([
					{ name: 'MY_SCHEMA', comment: 'a schema' },
					{ name: 'OTHER_SCHEMA', comment: null },
				]),
			);

			const [result] = await node.execute.call(makeContext({ operation: 'listSchemas' }));

			expect(mockDriver.query).toHaveBeenCalledWith(LIST_SCHEMAS_QUERY, undefined, undefined, 'raw');
			expect(mockDriver.prepare).not.toHaveBeenCalled();
			expect(result).toEqual([
				{ json: { name: 'MY_SCHEMA', comment: 'a schema' }, pairedItem: { item: 0 } },
				{ json: { name: 'OTHER_SCHEMA', comment: null }, pairedItem: { item: 0 } },
			]);
		});

		it('returns an empty array when there are no schemas', async () => {
			mockDriver.query.mockResolvedValue(selectResult([]));

			const [result] = await node.execute.call(makeContext({ operation: 'listSchemas' }));

			expect(result).toEqual([]);
		});

		it('throws NodeOperationError when the driver reports status: error', async () => {
			mockDriver.query.mockResolvedValue({
				status: 'error',
				exception: { sqlCode: 'E-1', text: 'connection lost' },
			});

			await expect(
				node.execute.call(makeContext({ operation: 'listSchemas' })),
			).rejects.toBeInstanceOf(NodeOperationError);
		});

		it('stores the error (with query text) in json when continueOnFail is true', async () => {
			mockDriver.query.mockRejectedValue(new Error('boom'));

			const ctx = makeContext({ operation: 'listSchemas', continueOnFail: true });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toEqual({ error: `boom (query: ${LIST_SCHEMAS_QUERY})` });
		});

		it('throws NodeOperationError when continueOnFail is false', async () => {
			mockDriver.query.mockRejectedValue(new Error('boom'));

			await expect(
				node.execute.call(makeContext({ operation: 'listSchemas', continueOnFail: false })),
			).rejects.toBeInstanceOf(NodeOperationError);
		});

		it('runs one query per input item and concatenates the rows', async () => {
			mockDriver.query
				.mockResolvedValueOnce(selectResult([{ name: 'A', comment: null }]))
				.mockResolvedValueOnce(selectResult([{ name: 'B', comment: null }]));

			const ctx = makeContext({ operation: 'listSchemas', items: [{ json: {} }, { json: {} }] });
			const [result] = await node.execute.call(ctx);

			expect(mockDriver.query).toHaveBeenCalledTimes(2);
			expect(result[0].pairedItem).toEqual({ item: 0 });
			expect(result[1].pairedItem).toEqual({ item: 1 });
		});

		it('uses a fallback message when the error response has no exception details', async () => {
			mockDriver.query.mockResolvedValue({ status: 'error', exception: undefined });

			const ctx = makeContext({ operation: 'listSchemas', continueOnFail: true });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toEqual({
				error: `Query failed (query: ${LIST_SCHEMAS_QUERY})`,
			});
		});

		it('returns no rows when the response has no results (defensive)', async () => {
			mockDriver.query.mockResolvedValue({
				status: 'ok',
				responseData: { numResults: 0, results: [] },
			});

			const [result] = await node.execute.call(makeContext({ operation: 'listSchemas' }));

			expect(result).toEqual([]);
		});

		it('throws instead of returning rows when the response has no responseData at all (e.g. a network hiccup)', async () => {
			mockDriver.query.mockResolvedValue({ status: 'ok' });

			const ctx = makeContext({ operation: 'listSchemas', continueOnFail: true });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toEqual({
				error: `Query returned no response data (query: ${LIST_SCHEMAS_QUERY})`,
			});
		});
	});

	// ── List Tables ──────────────────────────────────────────────────────────────

	describe('List Tables', () => {
		it('queries EXA_ALL_TABLES only when Include Views is false', async () => {
			mockStatement.execute.mockResolvedValue(
				selectResult([{ schema: 'MY_SCHEMA', name: 'ITEMS', comment: null, type: 'TABLE' }]),
			);

			const [result] = await node.execute.call(
				makeContext({ operation: 'listTables', includeViews: false }),
			);

			expect(mockDriver.prepare).toHaveBeenCalledWith(LIST_TABLES_QUERY);
			expect(mockStatement.execute).toHaveBeenCalledWith('MY_SCHEMA');
			expect(result[0].json).toEqual({ schema: 'MY_SCHEMA', name: 'ITEMS', comment: null, type: 'TABLE' });
		});

		it('UNION ALLs EXA_ALL_VIEWS when Include Views is true, binding schema twice', async () => {
			mockStatement.execute.mockResolvedValue(
				selectResult([
					{ schema: 'MY_SCHEMA', name: 'ITEMS', comment: null, type: 'TABLE' },
					{ schema: 'MY_SCHEMA', name: 'ITEMS_VIEW', comment: null, type: 'VIEW' },
				]),
			);

			const [result] = await node.execute.call(
				makeContext({ operation: 'listTables', includeViews: true }),
			);

			expect(mockDriver.prepare).toHaveBeenCalledWith(LIST_TABLES_WITH_VIEWS_QUERY);
			expect(mockStatement.execute).toHaveBeenCalledWith('MY_SCHEMA', 'MY_SCHEMA');
			expect(result.map((item) => item.json.type)).toEqual(['TABLE', 'VIEW']);
		});

		it('returns an empty array when the schema has no tables', async () => {
			mockStatement.execute.mockResolvedValue(selectResult([]));

			const [result] = await node.execute.call(makeContext({ operation: 'listTables' }));

			expect(result).toEqual([]);
		});

		it('throws NodeOperationError for an empty Schema', async () => {
			const ctx = makeContext({ operation: 'listTables', schema: '' });

			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).message).toContain('Schema must not be empty');
			expect(mockDriver.prepare).not.toHaveBeenCalled();
		});

		it('throws NodeOperationError when the driver reports status: error', async () => {
			mockStatement.execute.mockResolvedValue({
				status: 'error',
				exception: { sqlCode: 'E-1', text: 'schema not found' },
			});

			await expect(
				node.execute.call(makeContext({ operation: 'listTables' })),
			).rejects.toBeInstanceOf(NodeOperationError);
		});

		it('stores the error (with query text) in json when continueOnFail is true', async () => {
			mockStatement.execute.mockRejectedValue(new Error('boom'));

			const ctx = makeContext({ operation: 'listTables', continueOnFail: true });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toEqual({ error: `boom (query: ${LIST_TABLES_QUERY})` });
		});

		it('closes the prepared statement even when execution fails', async () => {
			mockStatement.execute.mockRejectedValue(new Error('boom'));

			await node.execute.call(makeContext({ operation: 'listTables', continueOnFail: true }));

			expect(mockStatement.close).toHaveBeenCalledTimes(1);
		});
	});

	// ── Describe Table ───────────────────────────────────────────────────────────

	describe('Describe Table', () => {
		it('returns one item per column, followed by a constraints summary item', async () => {
			mockStatement.execute
				.mockResolvedValueOnce(
					selectResult([
						{ name: 'ID', type: 'DECIMAL(18,0)', nullable: false, default: null, comment: 'the id' },
						{ name: 'NAME', type: 'VARCHAR(100)', nullable: true, default: null, comment: null },
					]),
				)
				.mockResolvedValueOnce(selectResult([]));

			const [result] = await node.execute.call(makeContext({ operation: 'describeTable' }));

			expect(mockDriver.prepare).toHaveBeenNthCalledWith(1, DESCRIBE_TABLE_COLUMNS_QUERY);
			expect(mockDriver.prepare).toHaveBeenNthCalledWith(2, DESCRIBE_TABLE_CONSTRAINTS_QUERY);
			expect(mockStatement.execute).toHaveBeenNthCalledWith(1, 'MY_SCHEMA', 'MY_TABLE');
			expect(mockStatement.execute).toHaveBeenNthCalledWith(2, 'MY_SCHEMA', 'MY_TABLE');

			expect(result).toHaveLength(3);
			expect(result[0].json).toEqual({
				name: 'ID',
				type: 'DECIMAL(18,0)',
				nullable: false,
				default: null,
				comment: 'the id',
			});
			expect(result[1].json).toEqual({
				name: 'NAME',
				type: 'VARCHAR(100)',
				nullable: true,
				default: null,
				comment: null,
			});
			expect(result[2].json).toEqual({ constraints: [] });
			result.forEach((item) => expect(item.pairedItem).toEqual({ item: 0 }));
		});

		it('groups a composite PRIMARY KEY spanning multiple rows into one constraint', async () => {
			mockStatement.execute
				.mockResolvedValueOnce(selectResult([]))
				.mockResolvedValueOnce(
					selectResult([
						{
							type: 'PRIMARY KEY',
							name: 'SKI_RUN_PK',
							columnName: 'RESORT_ID',
							referencedSchema: null,
							referencedTable: null,
							referencedColumn: null,
						},
						{
							type: 'PRIMARY KEY',
							name: 'SKI_RUN_PK',
							columnName: 'RUN_NAME',
							referencedSchema: null,
							referencedTable: null,
							referencedColumn: null,
						},
					]),
				);

			const [[summaryItem]] = await node.execute.call(makeContext({ operation: 'describeTable' }));

			expect(summaryItem.json).toEqual({
				constraints: [
					{
						type: 'PRIMARY KEY',
						name: 'SKI_RUN_PK',
						columns: ['RESORT_ID', 'RUN_NAME'],
						referencedSchema: null,
						referencedTable: null,
						referencedColumns: [],
					},
				],
			});
		});

		it('groups a composite FOREIGN KEY, pairing columns with their referenced columns positionally', async () => {
			mockStatement.execute
				.mockResolvedValueOnce(selectResult([]))
				.mockResolvedValueOnce(
					selectResult([
						{
							type: 'FOREIGN KEY',
							name: 'COMPETITION_FK',
							columnName: 'RESORT_ID',
							referencedSchema: 'MY_SCHEMA',
							referencedTable: 'SKI_RUN',
							referencedColumn: 'RESORT_ID',
						},
						{
							type: 'FOREIGN KEY',
							name: 'COMPETITION_FK',
							columnName: 'COMPETITION_RUN',
							referencedSchema: 'MY_SCHEMA',
							referencedTable: 'SKI_RUN',
							referencedColumn: 'RUN_NAME',
						},
					]),
				);

			const [[summaryItem]] = await node.execute.call(makeContext({ operation: 'describeTable' }));

			expect(summaryItem.json).toEqual({
				constraints: [
					{
						type: 'FOREIGN KEY',
						name: 'COMPETITION_FK',
						columns: ['RESORT_ID', 'COMPETITION_RUN'],
						referencedSchema: 'MY_SCHEMA',
						referencedTable: 'SKI_RUN',
						referencedColumns: ['RESORT_ID', 'RUN_NAME'],
					},
				],
			});
		});

		it('reports name: null for an auto-generated SYS_-prefixed constraint name', async () => {
			mockStatement.execute
				.mockResolvedValueOnce(selectResult([]))
				.mockResolvedValueOnce(
					selectResult([
						{
							type: 'NOT NULL',
							name: 'SYS_1234567890',
							columnName: 'ID',
							referencedSchema: null,
							referencedTable: null,
							referencedColumn: null,
						},
					]),
				);

			const [[summaryItem]] = await node.execute.call(makeContext({ operation: 'describeTable' }));

			expect(summaryItem.json).toEqual({
				constraints: [
					{
						type: 'NOT NULL',
						name: null,
						columns: ['ID'],
						referencedSchema: null,
						referencedTable: null,
						referencedColumns: [],
					},
				],
			});
		});

		it('keeps two differently named constraints separate', async () => {
			mockStatement.execute
				.mockResolvedValueOnce(selectResult([]))
				.mockResolvedValueOnce(
					selectResult([
						{
							type: 'PRIMARY KEY',
							name: 'PK',
							columnName: 'ID',
							referencedSchema: null,
							referencedTable: null,
							referencedColumn: null,
						},
						{
							type: 'FOREIGN KEY',
							name: 'FK',
							columnName: 'PARENT_ID',
							referencedSchema: 'S',
							referencedTable: 'PARENT',
							referencedColumn: 'ID',
						},
					]),
				);

			const [[summaryItem]] = await node.execute.call(makeContext({ operation: 'describeTable' }));

			expect((summaryItem.json.constraints as unknown[])).toHaveLength(2);
		});

		it('throws NodeOperationError for an empty Table', async () => {
			const ctx = makeContext({ operation: 'describeTable', table: '' });

			const thrown = await node.execute.call(ctx).catch((e) => e);

			expect(thrown).toBeInstanceOf(NodeOperationError);
			expect((thrown as NodeOperationError).message).toContain('Table must not be empty');
			expect(mockDriver.prepare).not.toHaveBeenCalled();
		});

		it('throws NodeOperationError when the columns query reports status: error', async () => {
			mockStatement.execute.mockResolvedValueOnce({
				status: 'error',
				exception: { sqlCode: 'E-1', text: 'table not found' },
			});

			await expect(
				node.execute.call(makeContext({ operation: 'describeTable' })),
			).rejects.toBeInstanceOf(NodeOperationError);
		});

		it('throws NodeOperationError when the constraints query reports status: error', async () => {
			mockStatement.execute
				.mockResolvedValueOnce(selectResult([]))
				.mockResolvedValueOnce({
					status: 'error',
					exception: { sqlCode: 'E-1', text: 'permission denied' },
				});

			await expect(
				node.execute.call(makeContext({ operation: 'describeTable' })),
			).rejects.toBeInstanceOf(NodeOperationError);
		});

		it('stores the error (with query text) in json when continueOnFail is true', async () => {
			mockStatement.execute.mockRejectedValueOnce(new Error('boom'));

			const ctx = makeContext({ operation: 'describeTable', continueOnFail: true });
			const [[item]] = await node.execute.call(ctx);

			expect(item.json).toEqual({ error: `boom (query: ${DESCRIBE_TABLE_COLUMNS_QUERY})` });
		});
	});
});
