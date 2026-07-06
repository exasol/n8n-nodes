import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver, ResultSet, SQLQueryResponse } from '@exasol/exasol-driver-ts';

// A single Exasol cell value as returned over the WebSocket protocol.
type ExasolColumnValue = string | number | boolean | null;

// Converts the columnar ResultSet wire format from the Exasol WebSocket protocol
// into an array of row objects keyed by column name. The driver stores result data
// as data[columnIndex][rowIndex] (column-major); this pivots it to the row-major
// shape that n8n expects.
function resultSetToRows(resultSet: ResultSet): Array<Record<string, ExasolColumnValue>> {
	const { columns, data, numRows } = resultSet;
	if (!data || numRows === 0) return [];
	return Array.from({ length: numRows }, (_, rowIdx) => {
		const row: Record<string, ExasolColumnValue> = {};
		columns.forEach((col, colIdx) => {
			row[col.name] = data[colIdx]?.[rowIdx] ?? null;
		});
		return row;
	});
}

// Reads the Parameters fixed-collection for one input item and returns the ordered
// list of bound values. Returns [] when no parameters are configured (raw path).
//
// In n8n, a fixedCollection with multipleValues returns { values: [{value: ...}, ...] }.
// getNodeParameter's third argument is the fallback when the field has not been set.
function extractParams(context: IExecuteFunctions, itemIndex: number): unknown[] {
	const collection = context.getNodeParameter('parameters', itemIndex, {}) as {
		values?: Array<{ value: unknown }>;
	};
	return (collection.values ?? []).map((p) => p.value);
}

// Reads and validates the query for one input item. Throws NodeOperationError (with
// itemIndex) when the query is empty so callers always get a well-contextualised error.
function readQuery(context: IExecuteFunctions, itemIndex: number): string {
	const query = context.getNodeParameter('query', itemIndex) as string;
	if (!query.trim()) {
		throw new NodeOperationError(context.getNode(), 'SQL Query must not be empty', { itemIndex });
	}
	return query;
}

// Maps the results array from a driver response to n8n execution data.
// A valid 'ok' response can have an empty results array for certain DDL
// statements; treated as zero affected rows rather than crashing on results[0].
function mapResults(
	results: SQLQueryResponse[] | undefined,
	itemIndex: number,
): INodeExecutionData[] {
	if (!results || results.length === 0) {
		return [{ json: { affectedRows: 0 }, pairedItem: { item: itemIndex } }];
	}
	const result = results[0];
	if (result.resultType === 'resultSet' && result.resultSet) {
		return resultSetToRows(result.resultSet).map((row) => ({
			json: row,
			pairedItem: { item: itemIndex },
		}));
	}
	return [{ json: { affectedRows: result.rowCount ?? 0 }, pairedItem: { item: itemIndex } }];
}

// Executes one query for one input item, choosing the path based on whether
// parameters were provided.
//
// Raw path (no params):
//   Uses driver.query() with responseType 'raw' so the driver returns the full
//   SQLResponse without hard-throwing on result type. We inspect resultType
//   ourselves, which correctly handles WITH...SELECT and WITH...INSERT/UPDATE/DELETE
//   without needing to pre-classify the SQL text.
//
// Parameterized path: driver.prepare() + stmt.execute() prevents SQL injection.
//   - SELECT result set → rows
//   - rowCount / empty result → { affectedRows: N }
async function runQuery(
	driver: ExasolDriver,
	query: string,
	params: unknown[],
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	if (params.length === 0) {
		const raw = await driver.query(query, undefined, undefined, 'raw');
		if (raw.status === 'error') {
			throw new Error(raw.exception?.text || 'Query execution failed');
		}
		if (!raw.responseData) {
			throw new Error('Query returned no response data');
		}
		return mapResults(raw.responseData.results, itemIndex);
	}

	// Parameterized path: spread params as positional arguments to stmt.execute().
	const stmt = await driver.prepare(query);
	try {
		const response = await stmt.execute(...params);
		if (response.status === 'error') {
			throw new Error(response.exception?.text || 'Prepared statement execution failed');
		}
		return mapResults(response.responseData.results, itemIndex);
	} finally {
		await stmt.close().catch(() => {});
	}
}

// Processes each item sequentially (no transaction). Per-item errors are caught
// and either converted to error output items (continueOnFail) or re-thrown.
async function executeSequentially(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const returnData: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			// getNodeParameter evaluates per-item expressions (e.g. ={{$json.query}}).
			const query = readQuery(context, i);
			const params = extractParams(context, i);
			returnData.push(...(await runQuery(driver, query, params, i)));
		} catch (error) {
			// continueOnFail: capture the error as an output item rather than aborting.
			if (context.continueOnFail()) {
				returnData.push({
					json: { error: (error as Error).message },
					pairedItem: { item: i },
				});
				continue;
			}
			// Re-throw NodeOperationErrors as-is — readQuery already set the correct itemIndex.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- already a NodeOperationError; rule cannot track instanceof narrowing
			if (error instanceof NodeOperationError) throw error;
			throw new NodeOperationError(context.getNode(), error as Error, { itemIndex: i });
		}
	}

	return returnData;
}

// Wraps all items in a single DB transaction. Either all succeed (COMMIT) or
// all are rolled back on the first failure (ROLLBACK). continueOnFail does not
// apply per-item here — the transaction is atomic by design.
async function executeTransaction(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const returnData: INodeExecutionData[] = [];

	// Disable autocommit for this session so statements are held in a transaction.
	// Passing { autocommit: false } as an attribute sets the session-level autocommit
	// flag via the Exasol WebSocket protocol before executing the COMMIT statement.
	// The COMMIT is a no-op when no prior transaction is open; it just ensures a
	// clean transaction boundary.
	await driver.execute('COMMIT', { autocommit: false });

	// Track the current item index so DB-level errors from runQuery — which arrive as
	// plain Error objects — can be attributed to the correct input item.
	let currentItemIndex = 0;
	try {
		for (let i = 0; i < items.length; i++) {
			currentItemIndex = i;
			const query = readQuery(context, i); // throws NodeOperationError(itemIndex: i) if empty
			const params = extractParams(context, i);
			returnData.push(...(await runQuery(driver, query, params, i)));
		}
		await driver.execute('COMMIT');
		return returnData;
	} catch (error) {
		// ROLLBACK is best-effort: if it fails, the connection will be closed anyway.
		await driver.execute('ROLLBACK').catch(() => {});
		// continueOnFail: transaction mode is atomic, so the whole transaction becomes one error item.
		if (context.continueOnFail()) {
			return [
				{ json: { error: (error as Error).message }, pairedItem: { item: currentItemIndex } },
			];
		}
		// Re-throw NodeOperationErrors as-is — readQuery already set the correct itemIndex.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- already a NodeOperationError; rule cannot track instanceof narrowing
		if (error instanceof NodeOperationError) throw error;
		throw new NodeOperationError(context.getNode(), error as Error, {
			itemIndex: currentItemIndex,
		});
	} finally {
		// Restore autocommit. COMMIT with autocommit: true sets the session flag without
		// opening a new transaction. SELECT 1 cannot be used here because driver.execute()
		// rejects result-set queries (E-EDJS-10).
		await driver.execute('COMMIT', { autocommit: true }).catch(() => {});
	}
}

/**
 * Executes the "Execute Query" operation for all n8n input items.
 *
 * Dispatches to one of two execution strategies based on the executionMode
 * parameter. Supports optional parameter binding via prepare() for ? placeholders.
 *
 * Called with `this` bound to IExecuteFunctions so n8n's per-item parameter
 * and credential APIs are available without passing the context explicitly.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param items  - the n8n input items for this execution
 * @returns flat list of INodeExecutionData items (rows or { affectedRows: N })
 */
export async function execute(
	this: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	// executionMode is noDataExpression: true — same for all items; safe to read at index 0.
	const executionMode = this.getNodeParameter('executionMode', 0, 'sequentially') as string;

	if (executionMode === 'transaction') {
		return executeTransaction(this, driver, items);
	}
	return executeSequentially(this, driver, items);
}
