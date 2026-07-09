import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { buildRow, readColumns } from '../shared/columnMappings';
import { runStatement } from '../shared/statementRunner';
import { requireNonEmpty } from '../shared/validation';
import { quoteIdentifier } from '../shared/whereBuilder';

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
			const affectedRows = await runStatement(driver, query, rows.flat(), 'Insert failed');
			return [{ json: { affectedRows }, pairedItem }];
		} catch (error) {
			// Neither the driver nor runStatement() include the SQL text in their error messages, so
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
