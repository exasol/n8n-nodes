import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { readColumnMappings } from '../shared/columnMappings';
import { runStatement } from '../shared/statementRunner';
import { requireNonEmpty } from '../shared/validation';
import { buildWhereClause, quoteIdentifier, readWhereConditions } from '../shared/whereBuilder';

/**
 * Determines the SET-clause columns and values for one input item. Unlike Insert — which sends
 * every item as one row of a single combined statement and therefore fixes its column list from
 * item 0 alone — Update runs one independent UPDATE per item, so both the column list and the
 * values are read fresh for each item.
 *
 * Auto-Map Input Data takes its columns straight from the item's own JSON keys/values. Map Each
 * Column Below takes them from the "Columns" collection configured on the node, evaluated for
 * this item (an expression like ={{$json.value}} can therefore differ per item). A missing value
 * (a mapping row with no Value set) becomes null rather than undefined — the Exasol driver binds
 * null as SQL NULL, not as a missing placeholder.
 *
 * @param context - execute context, used to read node parameters for this item
 * @param dataMode - either 'autoMapInputData' or 'defineBelow'
 * @param item - the input item, whose JSON keys/values are used when dataMode is 'autoMapInputData'
 * @param itemIndex - index of the input item being processed
 * @returns the columns and values to set, in the order they should appear in SET
 */
function readSetColumns(
	context: IExecuteFunctions,
	dataMode: unknown,
	item: INodeExecutionData,
	itemIndex: number,
): Array<{ column: string; value: unknown }> {
	if (dataMode === 'defineBelow') {
		return readColumnMappings(context, itemIndex).map((mapping) => {
			if (typeof mapping.column !== 'string' || !mapping.column.trim()) {
				throw new NodeOperationError(context.getNode(), 'Column name must be a non-empty string.', {
					itemIndex,
				});
			}
			return { column: mapping.column, value: mapping.value ?? null };
		});
	}
	return Object.entries(item.json).map(([column, value]) => ({ column, value: value ?? null }));
}

/**
 * Builds `"c1" = ?, "c2" = ?` and the params bound to each `?`, in the same left-to-right order.
 *
 * @param columns - columns and values to set, as produced by readSetColumns()
 * @returns clause — the SET clause fragment; params — bound values in placeholder order
 */
function buildSetClause(columns: Array<{ column: string; value: unknown }>): {
	clause: string;
	params: unknown[];
} {
	return {
		clause: columns.map((column) => `${quoteIdentifier(column.column)} = ?`).join(', '),
		params: columns.map((column) => column.value),
	};
}

/**
 * Assembles `UPDATE "schema"."table" SET "c1" = ?, "c2" = ? WHERE ...`. The WHERE clause is
 * guaranteed non-empty by the caller (see execute() below) before this is called.
 *
 * @param schema - schema containing the table to update
 * @param table - table to update
 * @param setClause - SET clause fragment produced by buildSetClause()
 * @param whereClause - WHERE clause fragment produced by buildWhereClause(), including the WHERE keyword
 * @returns the full UPDATE statement text
 */
function buildUpdateQuery(
	schema: string,
	table: string,
	setClause: string,
	whereClause: string,
): string {
	return `UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} SET ${setClause} ${whereClause}`;
}

/**
 * Builds and runs the UPDATE statement for a single input item: reads schema, table, SET
 * columns, and WHERE conditions for that item, then executes it. Split out of execute() so the
 * per-item logic (several validation branches plus a nested try/catch around the query itself)
 * doesn't also carry the loop and continueOnFail branching — keeping each function's cognitive
 * complexity low on its own.
 *
 * @param context - execute context, used to read node parameters for this item
 * @param driver - an already-connected ExasolDriver instance
 * @param item - the input item being updated
 * @param itemIndex - index of the input item being processed
 * @returns the output item for this update, `{ json: { affectedRows: N } }`
 */
async function processItem(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	item: INodeExecutionData,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const schema = requireNonEmpty(
		context,
		context.getNodeParameter('schema', itemIndex),
		'Schema',
		itemIndex,
	);
	const table = requireNonEmpty(
		context,
		context.getNodeParameter('table', itemIndex),
		'Table',
		itemIndex,
	);
	const dataMode = context.getNodeParameter('dataMode', itemIndex, 'autoMapInputData');

	const setColumns = readSetColumns(context, dataMode, item, itemIndex);
	if (setColumns.length === 0) {
		throw new NodeOperationError(
			context.getNode(),
			'No columns to update. Add at least one column under Columns, or ensure the input item has at least one JSON key.',
			{ itemIndex },
		);
	}
	const set = buildSetClause(setColumns);

	const combineConditions = context.getNodeParameter('combineConditions', itemIndex, 'AND');
	const where = buildWhereClause(readWhereConditions(context, itemIndex), combineConditions);
	if (!where.clause) {
		throw new NodeOperationError(
			context.getNode(),
			'Where conditions are required for Update. Add at least one condition under Where — Update refuses to run against every row in the table.',
			{ itemIndex },
		);
	}

	const query = buildUpdateQuery(schema, table, set.clause, where.clause);

	try {
		const affectedRows = await runStatement(
			driver,
			query,
			[...set.params, ...where.params],
			'Update failed',
		);
		return { json: { affectedRows }, pairedItem: { item: itemIndex } };
	} catch (error) {
		// Neither the driver nor runStatement() include the SQL text in their error messages, so
		// it's appended here — mirrors the identical pattern in selectRows/execute.ts and
		// insert/execute.ts.
		throw new NodeOperationError(
			context.getNode(),
			`${(error as Error).message} (query: ${query})`,
			{ itemIndex },
		);
	}
}

/**
 * Executes the "Update" operation for all n8n input items.
 *
 * Runs one UPDATE statement per input item — schema, table, SET columns, and WHERE conditions
 * can all vary per item via n8n expressions, same as every other field read with
 * getNodeParameter(name, itemIndex). WHERE is required: an item whose Where collection resolves
 * to no conditions is rejected rather than silently updating every row in the table.
 *
 * Called with `this` bound to IExecuteFunctions so n8n's per-item parameter APIs are available
 * without passing the context explicitly.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param items  - the n8n input items for this execution
 * @returns one output item per input item, each `{ json: { affectedRows: N } }`
 */
export async function execute(
	this: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const returnData: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			returnData.push(await processItem(this, driver, items[i], i));
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
