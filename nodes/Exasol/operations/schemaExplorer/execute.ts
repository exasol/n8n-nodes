import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { requireNonEmpty } from '../shared/validation';
import { runQuery, type QueryRow } from '../shared/statementRunner';

/**
 * The three Schema Explorer sub-operation values, as they appear in the "Operation" dropdown in
 * Exasol.node.ts. Exported so Exasol.node.ts can build its dispatch-branch membership check
 * without repeating the literal list a second time.
 */
export const SCHEMA_EXPLORER_OPERATIONS = ['listSchemas', 'listTables', 'describeTable'] as const;
export type SchemaExplorerOperation = (typeof SCHEMA_EXPLORER_OPERATIONS)[number];

/**
 * Wraps each row from a QueryRow[] (already pivoted to plain objects by runQuery/runRows) into
 * n8n's INodeExecutionData shape — the { json, pairedItem } envelope every operation's output
 * items must have. pairedItem tags which input item this output item was produced for, so n8n can
 * draw a line between an input and the output(s) it caused when the user inspects the workflow run.
 */
function toItems(rows: QueryRow[], itemIndex: number): INodeExecutionData[] {
	return rows.map((row) => ({ json: row, pairedItem: { item: itemIndex } }));
}

/**
 * Runs the List Schemas sub-operation for one input item: lists every schema in the database,
 * one output item per schema.
 *
 * @param context - the executing operation's IExecuteFunctions, for getNode()/error attribution
 * @param driver - an already-connected ExasolDriver instance
 * @param itemIndex - the input item this sub-operation is running for
 * @returns one output item per schema
 */
async function runListSchemas(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const query =
		'SELECT SCHEMA_NAME AS "name", SCHEMA_COMMENT AS "comment" FROM EXA_ALL_SCHEMAS ORDER BY SCHEMA_NAME';
	const rows = await runQuery(context, driver, query, [], itemIndex);
	return toItems(rows, itemIndex);
}

// Builds the List Tables query. Without includeViews it's a single filtered SELECT; with it, a
// second SELECT against EXA_ALL_VIEWS is UNION ALL-ed in. Both branches alias their columns to
// the same quoted names ("schema", "name", "comment", "type") so the union type-checks and the
// output shape is identical regardless of source view; `'TABLE'`/`'VIEW'` is added as a literal
// "type" column since the design doc's output shape has no other way to tell a table apart from
// a view once includeViews merges them into one list.
function buildListTablesQuery(schema: string, includeViews: boolean): { query: string; params: unknown[] } {
	const tablesQuery =
		'SELECT TABLE_SCHEMA AS "schema", TABLE_NAME AS "name", TABLE_COMMENT AS "comment", \'TABLE\' AS "type" FROM EXA_ALL_TABLES WHERE TABLE_SCHEMA = ?';
	if (!includeViews) {
		return { query: `${tablesQuery} ORDER BY "name"`, params: [schema] };
	}
	const viewsQuery =
		'SELECT VIEW_SCHEMA AS "schema", VIEW_NAME AS "name", VIEW_COMMENT AS "comment", \'VIEW\' AS "type" FROM EXA_ALL_VIEWS WHERE VIEW_SCHEMA = ?';
	return {
		query: `${tablesQuery} UNION ALL ${viewsQuery} ORDER BY "name"`,
		params: [schema, schema],
	};
}

/**
 * Runs the List Tables sub-operation for one input item: lists tables (and, if includeViews is
 * set, views) in the schema named by the "schema" parameter, one output item per table/view.
 *
 * @param context - the executing operation's IExecuteFunctions, for getNodeParameter()/getNode()
 * @param driver - an already-connected ExasolDriver instance
 * @param itemIndex - the input item this sub-operation is running for
 * @returns one output item per table (and view, if requested)
 */
async function runListTables(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const schema = requireNonEmpty(context, context.getNodeParameter('schema', itemIndex), 'Schema', itemIndex);
	const includeViews = context.getNodeParameter('includeViews', itemIndex, false) as boolean;
	const { query, params } = buildListTablesQuery(schema, includeViews);
	const rows = await runQuery(context, driver, query, params, itemIndex);
	return toItems(rows, itemIndex);
}

const DESCRIBE_TABLE_COLUMNS_QUERY =
	'SELECT COLUMN_NAME AS "name", COLUMN_TYPE AS "type", COLUMN_IS_NULLABLE AS "nullable", COLUMN_DEFAULT AS "default", COLUMN_COMMENT AS "comment" FROM EXA_ALL_COLUMNS WHERE COLUMN_SCHEMA = ? AND COLUMN_TABLE = ? ORDER BY COLUMN_ORDINAL_POSITION';

// ORDINAL_POSITION isn't selected (it's only needed to order rows within a constraint, not part
// of the output shape), but ORDER BY can still reference it since this is a plain, non-aggregated
// SELECT — standard SQL allows ordering by a column that isn't in the SELECT list.
const DESCRIBE_TABLE_CONSTRAINTS_QUERY =
	'SELECT CONSTRAINT_TYPE AS "type", CONSTRAINT_NAME AS "name", COLUMN_NAME AS "columnName", REFERENCED_SCHEMA AS "referencedSchema", REFERENCED_TABLE AS "referencedTable", REFERENCED_COLUMN AS "referencedColumn" FROM EXA_ALL_CONSTRAINT_COLUMNS WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_TABLE = ? ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION';

interface DescribeTableConstraint {
	type: string;
	name: string | null;
	columns: string[];
	referencedSchema: string | null;
	referencedTable: string | null;
	referencedColumns: string[];
}

/**
 * Collapses the per-(constraint, column) rows EXA_ALL_CONSTRAINT_COLUMNS returns — a composite
 * PRIMARY KEY or FOREIGN KEY spans multiple rows, one per column — into one object per
 * constraint, aggregating COLUMN_NAME/REFERENCED_COLUMN into arrays. The rows arrive already
 * ordered by (CONSTRAINT_NAME, ORDINAL_POSITION) from DESCRIBE_TABLE_CONSTRAINTS_QUERY, so a
 * composite key's columns and a composite FK's referencedColumns both come out in the right
 * order without any sorting here. Exasol auto-generates a "SYS_..."-prefixed name for
 * constraints the user didn't explicitly name (e.g. an inline PRIMARY KEY); those are reported as
 * name: null rather than surfacing the meaningless internal identifier.
 */
function groupConstraints(rows: QueryRow[]): DescribeTableConstraint[] {
	const byName = new Map<string, DescribeTableConstraint>();
	for (const row of rows) {
		const rawName = row.name as string;
		let constraint = byName.get(rawName);
		if (!constraint) {
			constraint = {
				type: row.type as string,
				name: rawName.startsWith('SYS_') ? null : rawName,
				columns: [],
				referencedSchema: (row.referencedSchema as string | null) ?? null,
				referencedTable: (row.referencedTable as string | null) ?? null,
				referencedColumns: [],
			};
			byName.set(rawName, constraint);
		}
		constraint.columns.push(row.columnName as string);
		if (row.referencedColumn) {
			constraint.referencedColumns.push(row.referencedColumn as string);
		}
	}
	return [...byName.values()];
}

/**
 * Runs the Describe Table sub-operation for one input item: describes the table (or view) named
 * by the "schema"/"table" parameters, emitting one output item per column plus a final summary
 * item listing its constraints (see groupConstraints() above).
 *
 * @param context - the executing operation's IExecuteFunctions, for getNodeParameter()/getNode()
 * @param driver - an already-connected ExasolDriver instance
 * @param itemIndex - the input item this sub-operation is running for
 * @returns one output item per column, followed by one constraints-summary item
 */
async function runDescribeTable(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const schema = requireNonEmpty(context, context.getNodeParameter('schema', itemIndex), 'Schema', itemIndex);
	const table = requireNonEmpty(context, context.getNodeParameter('table', itemIndex), 'Table', itemIndex);

	const columnRows = await runQuery(
		context,
		driver,
		DESCRIBE_TABLE_COLUMNS_QUERY,
		[schema, table],
		itemIndex,
	);
	const constraintRows = await runQuery(
		context,
		driver,
		DESCRIBE_TABLE_CONSTRAINTS_QUERY,
		[schema, table],
		itemIndex,
	);

	// "Plus a constraints summary item" (design doc) — one item total summarizing every
	// constraint, appended after the per-column items, not one item per constraint.
	const summaryItem: INodeExecutionData = {
		json: { constraints: groupConstraints(constraintRows) },
		pairedItem: { item: itemIndex },
	};

	return [...toItems(columnRows, itemIndex), summaryItem];
}

/**
 * Executes one of the three Schema Explorer sub-operations for all n8n input items. Unlike every
 * other operation's execute(), this one takes the specific sub-operation as an explicit
 * parameter, since all three (List Schemas, List Tables, Describe Table) are dispatched here from
 * a single entry in Exasol.node.ts, per this feature's one-folder file layout.
 *
 * Same per-item shape as every other operation: one query attempt per input item, `continueOnFail`
 * turning a failure into an error output item instead of aborting the whole execution, and
 * NodeOperationError carrying the failing item's index.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param items - the n8n input items for this execution
 * @param operation - which Schema Explorer sub-operation to run
 * @returns flat list of INodeExecutionData items
 */
export async function execute(
	this: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
	operation: SchemaExplorerOperation,
): Promise<INodeExecutionData[]> {
	const returnData: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			if (operation === 'listSchemas') {
				returnData.push(...(await runListSchemas(this, driver, i)));
			} else if (operation === 'listTables') {
				returnData.push(...(await runListTables(this, driver, i)));
			} else {
				returnData.push(...(await runDescribeTable(this, driver, i)));
			}
		} catch (error) {
			if (this.continueOnFail()) {
				returnData.push({
					json: { error: (error as Error).message },
					pairedItem: { item: i },
				});
				continue;
			}
			throw error instanceof NodeOperationError
				? error
				: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
		}
	}

	return returnData;
}
