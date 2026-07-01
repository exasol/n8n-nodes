import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

/**
 * Executes the "Execute Query" operation for all n8n input items.
 *
 * Each item is processed independently: its `query` parameter is read,
 * executed against Exasol, and the result rows appended to the output.
 * If continueOnFail is enabled and a query fails, the error is captured
 * as a json output item instead of aborting the whole execution.
 *
 * Called with `this` bound to IExecuteFunctions so n8n's parameter and
 * credential APIs are available without passing the context explicitly.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param items  - the n8n input items for this execution
 * @returns flat list of INodeExecutionData items, one per result row
 */
export async function execute(
	this: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const returnData: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			// getNodeParameter reads per-item values; the item index is required because
			// n8n expressions (e.g. "={{$json.query}}") are evaluated per input item.
			const query = this.getNodeParameter('query', i) as string;
			if (!query.trim()) {
				throw new NodeOperationError(this.getNode(), 'SQL Query must not be empty', {
					itemIndex: i,
				});
			}
			const result = await driver.query(query);
			// getRows() converts Exasol's columnar wire format to {columnName: value} objects.
			const rows = result.getRows();

			returnData.push(
				...rows.map((row) => ({
					json: row,
					pairedItem: { item: i },
				})),
			);
		} catch (error) {
			// continueOnFail: when true, errors are surfaced as output items rather than
			// aborting execution — lets downstream nodes handle failures gracefully.
			if (this.continueOnFail()) {
				// Preserve the item index so downstream nodes can identify which item failed.
				returnData.push({
					json: { error: (error as Error).message },
					pairedItem: { item: i },
				});
				continue;
			}
			throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
		}
	}

	return returnData;
}
