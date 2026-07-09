import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { runRawStatement } from '../shared/statementRunner';
import { requireNonEmpty } from '../shared/validation';
import {
	buildWhereClauseLiteral,
	quoteIdentifier,
	readWhereConditions,
} from '../shared/whereBuilder';

/**
 * Assembles `DELETE FROM "schema"."table" WHERE ...`, with WHERE values inlined as SQL literals
 * (see buildWhereClauseLiteral() in whereBuilder.ts for why Delete can't bind them as `?`
 * parameters the way Select Rows and Update do). The WHERE clause is guaranteed non-empty by the
 * caller (see execute() below) before this is called.
 *
 * @param schema - schema containing the table to delete from
 * @param table - table to delete from
 * @param whereClause - WHERE clause fragment produced by buildWhereClauseLiteral(), including the WHERE keyword
 * @returns the full DELETE statement text
 */
function buildDeleteQuery(schema: string, table: string, whereClause: string): string {
	return `DELETE FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ${whereClause}`;
}

/**
 * Builds and runs the DELETE statement for a single input item: reads schema, table, and WHERE
 * conditions for that item, then executes it. Split out of execute() so the per-item logic
 * (validation branches plus a nested try/catch around the query itself) doesn't also carry the
 * loop and continueOnFail branching — keeping each function's cognitive complexity low on its
 * own (same split as update/execute.ts's processItem()).
 *
 * @param context - execute context, used to read node parameters for this item
 * @param driver - an already-connected ExasolDriver instance
 * @param itemIndex - index of the input item being processed
 * @returns the output item for this delete, `{ json: { affectedRows: N } }`
 */
async function processItem(
	context: IExecuteFunctions,
	driver: ExasolDriver,
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

	const combineConditions = context.getNodeParameter('combineConditions', itemIndex, 'AND');
	const whereClause = buildWhereClauseLiteral(
		readWhereConditions(context, itemIndex),
		combineConditions,
	);
	if (!whereClause) {
		throw new NodeOperationError(
			context.getNode(),
			'Where conditions are required for Delete. Add at least one condition under Where — Delete refuses to run against every row in the table.',
			{ itemIndex },
		);
	}

	const query = buildDeleteQuery(schema, table, whereClause);

	try {
		const affectedRows = await runRawStatement(driver, query, 'Delete failed');
		return { json: { affectedRows }, pairedItem: { item: itemIndex } };
	} catch (error) {
		// Neither the driver nor runRawStatement() include the SQL text in their error messages,
		// so it's appended here — mirrors the identical pattern in update/execute.ts and
		// insert/execute.ts.
		throw new NodeOperationError(
			context.getNode(),
			`${(error as Error).message} (query: ${query})`,
			{ itemIndex },
		);
	}
}

/**
 * Executes the "Delete" operation for all n8n input items.
 *
 * Runs one DELETE statement per input item — schema, table, and WHERE conditions can all vary
 * per item via n8n expressions, same as every other field read with
 * getNodeParameter(name, itemIndex). WHERE is required: an item whose Where collection resolves
 * to no conditions is rejected rather than silently deleting every row in the table.
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
			returnData.push(await processItem(this, driver, i));
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
