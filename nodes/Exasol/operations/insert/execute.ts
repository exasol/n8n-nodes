import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { requireNonEmpty } from '../shared/validation';
import { quoteIdentifier } from '../shared/whereBuilder';

// Reads the "Columns" fixedCollection for one input item. A fixedCollection with
// multipleValues returns { mappings: [...] }, or {} when no rows have been added.
function readColumnMappings(
	context: IExecuteFunctions,
	itemIndex: number,
): Array<{ column: string; value?: unknown }> {
	const collection = context.getNodeParameter('columns', itemIndex, {}) as {
		mappings?: Array<{ column: string; value?: unknown }>;
	};
	return collection.mappings ?? [];
}

// Determines the column list for the combined statement. Insert sends every input item as one
// row of a single multi-row INSERT statement, so the column list — unlike the values — must be
// identical across all rows; it is therefore only read once, from item 0, rather than per item.
//
// Auto-Map Input Data takes its columns from item 0's own JSON keys. Map Each Column Below takes
// them from the "Columns" collection configured on the node (also read at item 0, since the
// column names themselves are not expected to vary by expression the way values are).
function readColumns(
	context: IExecuteFunctions,
	dataMode: unknown,
	firstItem: INodeExecutionData,
): string[] {
	if (dataMode === 'defineBelow') {
		const columns = readColumnMappings(context, 0).map((mapping) => mapping.column);
		if (columns.some((column) => typeof column !== 'string' || !column.trim())) {
			throw new NodeOperationError(context.getNode(), 'Column name must be a non-empty string.', {
				itemIndex: 0,
			});
		}
		return columns;
	}
	return Object.keys(firstItem.json);
}

// Builds one row of bound values, in the same column order returned by readColumns(). Missing
// values (a key absent from an item's JSON, or a column with no matching mapping row) become
// null rather than undefined — the Exasol driver binds null as SQL NULL, not as a missing
// placeholder. A mapping row naming a column outside readColumns()'s list throws instead (see
// below) rather than silently dropping that value.
function buildRow(
	context: IExecuteFunctions,
	dataMode: unknown,
	columns: string[],
	item: INodeExecutionData,
	itemIndex: number,
): unknown[] {
	if (dataMode === 'defineBelow') {
		const mappings = readColumnMappings(context, itemIndex);
		const valueByColumn = new Map(mappings.map((mapping) => [mapping.column, mapping.value]));

		// The column list itself is fixed from item 0 (see readColumns() above), but each item's
		// mapping is re-read here, so a Column-name expression that resolves to a different name
		// on a later item would otherwise go undetected: valueByColumn.get() would simply miss and
		// fall back to null below, silently dropping that value instead of erroring. A mapping row
		// naming a column outside item 0's column list is therefore rejected outright; a mapping
		// that just has *fewer* rows than item 0 is fine and intentionally still null-fills.
		const unknownColumns = mappings
			.map((mapping) => mapping.column)
			.filter((column) => !columns.includes(column));
		if (unknownColumns.length > 0) {
			throw new NodeOperationError(
				context.getNode(),
				`Item ${itemIndex} maps column(s) not present in the column list determined from item 0 (${columns.join(', ')}): ${unknownColumns.join(', ')}. When Column is set via an expression, it must resolve to the same column names for every item.`,
				{ itemIndex },
			);
		}

		return columns.map((column) => valueByColumn.get(column) ?? null);
	}
	const json = item.json as Record<string, unknown>;
	return columns.map((column) => json[column] ?? null);
}

// Assembles `INSERT INTO "schema"."table" ("c1","c2") VALUES (?,?),(?,?),...` — one VALUES
// tuple per input item, all bound via `?` and sent in a single prepare() + execute() round-trip.
function buildInsertQuery(
	schema: string,
	table: string,
	columns: string[],
	rowCount: number,
): string {
	const columnList = columns.map(quoteIdentifier).join(', ');
	const tuple = `(${columns.map(() => '?').join(', ')})`;
	const values = Array.from({ length: rowCount }, () => tuple).join(', ');
	return `INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columnList}) VALUES ${values}`;
}

// Runs the combined multi-row INSERT via prepare() + stmt.execute(), which prevents SQL
// injection on the bound values (identifiers are quoted separately by buildInsertQuery via
// quoteIdentifier). A missing rowCount is treated as zero affected rows rather than crashing,
// mirroring mapSingleResult()'s same defensive fallback in executeQuery/execute.ts.
async function runInsert(driver: ExasolDriver, query: string, params: unknown[]): Promise<number> {
	const stmt = await driver.prepare(query);
	try {
		const response = await stmt.execute(...params);
		if (response.status === 'error') {
			throw new Error(response.exception?.text || 'Insert failed');
		}
		return response.responseData?.results?.[0]?.rowCount ?? 0;
	} finally {
		await stmt.close().catch(() => {});
	}
}

/**
 * Executes the "Insert" operation for all n8n input items.
 *
 * Unlike Select Rows, Update, and Delete — which run one statement per input item — Insert
 * combines every item into a single multi-row INSERT statement (one VALUES tuple per item) and
 * sends it in one round-trip, regardless of how many items there are. This means the operation
 * succeeds or fails as a whole rather than per item: a single output item is returned, carrying
 * either `{ affectedRows: N }` or (with `continueOnFail`) the error, with `pairedItem` referencing
 * every input item.
 *
 * Called with `this` bound to IExecuteFunctions so n8n's per-item parameter APIs are available
 * without passing the context explicitly.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param items  - the n8n input items for this execution
 * @returns a single-item list: `[{ json: { affectedRows: N } }]`, or `[]` for empty input
 */
export async function execute(
	this: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	if (items.length === 0) return [];

	const pairedItem = items.map((_, i) => ({ item: i }));

	try {
		const schema = requireNonEmpty(this, this.getNodeParameter('schema', 0), 'Schema', 0);
		const table = requireNonEmpty(this, this.getNodeParameter('table', 0), 'Table', 0);
		const dataMode = this.getNodeParameter('dataMode', 0, 'autoMapInputData');

		const columns = readColumns(this, dataMode, items[0]);
		if (columns.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'No columns to insert. Add at least one column under Columns, or ensure the first input item has at least one JSON key.',
				{ itemIndex: 0 },
			);
		}

		const rows = items.map((item, i) => buildRow(this, dataMode, columns, item, i));
		const query = buildInsertQuery(schema, table, columns, items.length);

		try {
			const affectedRows = await runInsert(driver, query, rows.flat());
			return [{ json: { affectedRows }, pairedItem }];
		} catch (error) {
			// Neither the driver nor runInsert() include the SQL text in their error messages, so
			// it's appended here — mirrors the identical pattern in selectRows/execute.ts.
			throw new NodeOperationError(
				this.getNode(),
				`${(error as Error).message} (query: ${query})`,
				{ itemIndex: 0 },
			);
		}
	} catch (error) {
		if (this.continueOnFail()) {
			return [{ json: { error: (error as Error).message }, pairedItem }];
		}
		throw error instanceof NodeOperationError
			? error
			: new NodeOperationError(this.getNode(), error as Error, { itemIndex: 0 });
	}
}
