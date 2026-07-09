import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * Reads the "Columns" fixedCollection for one input item. A fixedCollection with
 * multipleValues returns { mappings: [...] }, or {} when no rows have been added.
 *
 * Shared by every operation that lets the user map columns explicitly via a "Columns" collection
 * (Insert, Update, and Upsert).
 *
 * @param context - execute context, used to read the node parameter for this item
 * @param itemIndex - index of the input item being processed
 * @returns the configured column/value mappings, or an empty array if none were added
 */
export function readColumnMappings(
	context: IExecuteFunctions,
	itemIndex: number,
): Array<{ column: string; value?: unknown }> {
	const collection = context.getNodeParameter('columns', itemIndex, {}) as {
		mappings?: Array<{ column: string; value?: unknown }>;
	};
	return collection.mappings ?? [];
}

/**
 * Returns the entries of `candidates` that aren't present in `knownColumns` — the "does this
 * column name actually exist in our mapped column list" check shared by buildRow() below (a
 * per-item Columns mapping naming a column outside item 0's list) and mergeBuilder.ts's Conflict
 * Columns validation (naming a column outside the mapped column list). Pure and throw-free: each
 * caller wraps the result in its own error type, message, and item attribution.
 */
export function findUnknownColumns(candidates: string[], knownColumns: string[]): string[] {
	return candidates.filter((column) => !knownColumns.includes(column));
}

/**
 * Determines the column list for a statement that batches every input item into one combined
 * statement — Insert and Upsert both work this way, unlike Select Rows/Update/Delete, which
 * issue one statement per item. Because the column list — unlike each row's values — must be
 * identical across every row, it is read only once, from item 0, rather than per item.
 *
 * Auto-Map Input Data takes its columns from item 0's own JSON keys. Map Each Column Below takes
 * them from the "Columns" collection configured on the node (also read at item 0, since the
 * column names themselves are not expected to vary by expression the way values are).
 *
 * @param context - execute context, used to read the node parameter for item 0
 * @param dataMode - either 'autoMapInputData' or 'defineBelow'
 * @param firstItem - the first input item, whose JSON keys are used when dataMode is
 *   'autoMapInputData'
 * @returns the columns to use, in the order they should appear in the generated statement
 * @throws NodeOperationError (itemIndex 0) when a defineBelow mapping's column name is not a
 *   non-empty string
 */
export function readColumns(
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

/**
 * Builds one row of bound values, in the same column order returned by readColumns(). Missing
 * values (a key absent from an item's JSON, or a column with no matching mapping row) become
 * null rather than undefined — the Exasol driver binds null as SQL NULL, not as a missing
 * placeholder.
 *
 * @param context - execute context, used to read the node parameter for this item
 * @param dataMode - either 'autoMapInputData' or 'defineBelow'
 * @param columns - the fixed column list determined by readColumns()
 * @param item - the input item to build a row for
 * @param itemIndex - index of the input item being processed
 * @returns the row's values, in the same order as `columns`
 * @throws NodeOperationError (itemIndex) when a defineBelow mapping row names a column outside
 *   `columns` — an expression resolving a Column name differently per item would otherwise
 *   silently drop that value as null instead of erroring
 */
export function buildRow(
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
		const unknownColumns = findUnknownColumns(
			mappings.map((mapping) => mapping.column),
			columns,
		);
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
