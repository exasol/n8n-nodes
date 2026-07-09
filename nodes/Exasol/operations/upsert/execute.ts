import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { buildRow, readColumns } from '../shared/columnMappings';
import { buildMergeQuery } from './mergeBuilder';
import { runRawStatement } from '../shared/statementRunner';
import { requireNonEmpty } from '../shared/validation';

/**
 * Executes the "Upsert" operation for all n8n input items.
 *
 * Like Insert, Upsert combines every input item into a single statement sent in one round-trip:
 * mergeBuilder.ts's buildMergeQuery() assembles a batched `MERGE INTO ... USING (VALUES ...)`
 * statement with one source row per item, rather than running one MERGE per item. The operation
 * therefore succeeds or fails as a whole rather than per item: a single output item is returned,
 * carrying either `{ affectedRows: N }` or (with `continueOnFail`) the error, with `pairedItem`
 * referencing every input item.
 *
 * Unlike Insert, the statement runs unprepared via runRawStatement() rather than prepare() +
 * bound `?` parameters — buildMergeQuery() inlines every row value as a SQL literal instead, for
 * the same reason Delete does (see its comment on buildWhereClauseLiteral()): Exasol's prepared
 * statement support rejects a `VALUES(?, ?)` placeholder list used as a MERGE source.
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
				'No columns to upsert. Add at least one column under Columns, or ensure the first input item has at least one JSON key.',
				{ itemIndex: 0 },
			);
		}

		// Read once from item 0, like Schema/Table/Data Mode above: Conflict Columns is a
		// structural choice about how the batch is merged, not per-item data.
		const conflictColumns = this.getNodeParameter('conflictColumns', 0, []) as unknown[];

		const rows = items.map((item, i) => buildRow(this, dataMode, columns, item, i));
		// buildMergeQuery() throws a plain Error (e.g. for an empty or unmapped Conflict Columns
		// list) — the outer catch below wraps anything that isn't already a NodeOperationError.
		const query = buildMergeQuery(schema, table, columns, conflictColumns, rows);

		try {
			const affectedRows = await runRawStatement(driver, query, 'Upsert failed');
			return [{ json: { affectedRows }, pairedItem }];
		} catch (error) {
			// Neither the driver nor runRawStatement() include the SQL text in their error messages,
			// so it's appended here — mirrors the identical pattern in insert/execute.ts, update/
			// execute.ts, and delete/execute.ts.
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
