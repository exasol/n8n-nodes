import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver, SQLQueryResponse } from '@exasol/exasol-driver-ts';

import { resultSetToRows } from '../shared/resultMapper';
import { runRawOrPrepared } from '../shared/statementRunner';
import { assertSelectOnly } from './selectOnlyGuard';

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
//
// restrictToSelect is passed in rather than re-read here because it's noDataExpression: true
// (see description.ts) — identical for every item in the execution — so it's read once in
// execute() below, the same way executionMode is.
//
// When Restrict to SELECT Queries is enabled (the default), also runs assertSelectOnly() —
// the mitigation for this node being usableAsTool: true with a freeform query field — and wraps
// its plain Error the same way, so the guard's rejection reads identically to any other
// per-item validation failure to continueOnFail / the caller.
function readQuery(context: IExecuteFunctions, itemIndex: number, restrictToSelect: boolean): string {
	const query = context.getNodeParameter('query', itemIndex) as string;
	if (!query.trim()) {
		throw new NodeOperationError(context.getNode(), 'SQL Query must not be empty', { itemIndex });
	}
	if (restrictToSelect) {
		try {
			assertSelectOnly(query);
		} catch (error) {
			throw new NodeOperationError(context.getNode(), error as Error, { itemIndex });
		}
	}
	return query;
}

// Maps one statement's result to n8n execution data for one input item. Missing
// result (undefined) is treated as zero affected rows rather than crashing — a
// valid 'ok' response can have an empty results array for certain DDL statements.
function mapSingleResult(
	result: SQLQueryResponse | undefined,
	itemIndex: number,
): INodeExecutionData[] {
	if (!result) {
		return [{ json: { affectedRows: 0 }, pairedItem: { item: itemIndex } }];
	}
	if (result.resultType === 'resultSet' && result.resultSet) {
		return resultSetToRows(result.resultSet).map((row) => ({
			json: row,
			pairedItem: { item: itemIndex },
		}));
	}
	return [{ json: { affectedRows: result.rowCount ?? 0 }, pairedItem: { item: itemIndex } }];
}

// Maps the results array from a driver response (one result per executed statement)
// to n8n execution data for a single-statement call — always reads results[0].
function mapResults(
	results: SQLQueryResponse[] | undefined,
	itemIndex: number,
): INodeExecutionData[] {
	return mapSingleResult(results?.[0], itemIndex);
}

// Executes one query for one input item. runRawOrPrepared (shared/statementRunner.ts) picks the
// raw (no params) vs prepared (bound params, SQL-injection-safe) path; we inspect resultType
// ourselves, which correctly handles WITH...SELECT and WITH...INSERT/UPDATE/DELETE without needing
// to pre-classify the SQL text.
//   - SELECT result set → rows
//   - rowCount / empty result → { affectedRows: N }
async function runQuery(
	driver: ExasolDriver,
	query: string,
	params: unknown[],
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const response = await runRawOrPrepared(driver, query, params);
	if (response.status === 'error') {
		throw new Error(response.exception?.text || 'Query execution failed');
	}
	if (!response.responseData) {
		throw new Error('Query returned no response data');
	}
	return mapResults(response.responseData.results, itemIndex);
}

// Re-throws NodeOperationErrors as-is (already correctly attributed, e.g. by
// readQuery); wraps any other error so every execution mode throws a consistent,
// correctly-typed failure instead of a raw Error.
function toNodeOperationError(
	context: IExecuteFunctions,
	error: unknown,
	itemIndex: number,
): NodeOperationError {
	if (error instanceof NodeOperationError) return error;
	return new NodeOperationError(context.getNode(), error as Error, { itemIndex });
}

// Processes each item sequentially (no transaction), sourcing each item's query and
// params via getQueryAndParams. Per-item errors are caught and either converted to
// error output items (continueOnFail) or re-thrown.
//
// getQueryAndParams is a callback rather than a plain array so that the common case
// (executeSequentially below) can read each item's parameters lazily, one at a time,
// exactly like the original per-item loop did — while executeBatched's fallback path
// can instead pass in already-evaluated values, avoiding a second evaluation of any
// n8n expression in the Query/Parameters fields.
async function runSequentially(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
	getQueryAndParams: (itemIndex: number) => { query: string; params: unknown[] },
): Promise<INodeExecutionData[]> {
	const returnData: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			const { query, params } = getQueryAndParams(i);
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
			throw toNodeOperationError(context, error, i);
		}
	}

	return returnData;
}

async function executeSequentially(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
	restrictToSelect: boolean,
): Promise<INodeExecutionData[]> {
	// getNodeParameter evaluates per-item expressions (e.g. ={{$json.query}}).
	return runSequentially(context, driver, items, (i) => ({
		query: readQuery(context, i, restrictToSelect),
		params: extractParams(context, i),
	}));
}

// Wraps all items in a single DB transaction. Either all succeed (COMMIT) or
// all are rolled back on the first failure (ROLLBACK). continueOnFail does not
// apply per-item here — the transaction is atomic by design.
async function executeTransaction(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
	restrictToSelect: boolean,
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
			const query = readQuery(context, i, restrictToSelect); // throws NodeOperationError(itemIndex: i) if empty
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
		throw toNodeOperationError(context, error, currentItemIndex);
	} finally {
		// Restore autocommit. COMMIT with autocommit: true sets the session flag without
		// opening a new transaction. SELECT 1 cannot be used here because driver.execute()
		// rejects result-set queries (E-EDJS-10).
		await driver.execute('COMMIT', { autocommit: true }).catch(() => {});
	}
}

// Sends every item's query in one driver.executeBatch() WebSocket round-trip instead
// of one round-trip per item. Only static SQL can be batched — the driver's
// executeBatch() takes plain strings with no place for bound ? parameters — so any
// item using Parameters causes the whole run to fall back to per-item execution.
//
// Any failure — whether validating a query before the batch is even sent, the batch
// call itself failing, or a result count that can't be mapped back to items — is
// reported as one failure across the whole run, never attributed to a specific item:
// Exasol's batch protocol returns one exception for the whole call with no indication
// of which statement failed or how many already ran. Recovering that would require
// wrapping the batch in a transaction and retrying item by item on failure — but that
// serializes every write behind a transaction on the happy path too, undermining the
// one-round-trip point of batching in the first place. n8n's own MySQL and Postgres
// nodes make the same trade-off in their "Single" query-batching mode (Postgres
// reports one undifferentiated error; MySQL hardcodes itemIndex: 0). continueOnFail
// still emits one output item per input item — just all carrying the same message —
// so downstream nodes see the item count they expect.
async function executeBatched(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
	restrictToSelect: boolean,
): Promise<INodeExecutionData[]> {
	if (items.length === 0) return [];

	try {
		// Read every item's query/params exactly once up front. The values are reused
		// below whichever path is taken (batched or the Parameters fallback) so an n8n
		// expression in Query or Parameters (e.g. ={{ $now }}) is never evaluated twice.
		const queries = items.map((_, i) => readQuery(context, i, restrictToSelect));
		const paramsByItem = items.map((_, i) => extractParams(context, i));

		if (paramsByItem.some((params) => params.length > 0)) {
			context.addExecutionHints({
				message:
					'Single Batch mode only supports parameter-free queries. Falling back to Sequentially because at least one item uses Parameters.',
				type: 'warning',
			});
			return await runSequentially(context, driver, items, (i) => ({
				query: queries[i],
				params: paramsByItem[i],
			}));
		}

		const response = await driver.executeBatch(queries);
		if (response.status === 'error') {
			throw new Error(response.exception?.text || 'Batch execution failed');
		}
		const results = response.responseData?.results ?? [];
		// Defensive guard, not a known failure mode: mapSingleResult's own comment notes
		// that a single query can come back with an empty results array for certain DDL
		// (unconfirmed whether this ever happens mid-batch — a live test against a real
		// Exasol instance with CREATE TABLE + INSERT did not reproduce it). With a single
		// item there's no ambiguity regardless — whatever came back belongs to that item —
		// but with more than one, a count mismatch would mean results can't be safely
		// mapped back to items by position, so fail loudly rather than risk silently
		// misattributing a result to the wrong item.
		if (items.length > 1 && results.length !== items.length) {
			throw new Error(
				`Single Batch mode expects one result per item, but the batch returned ${results.length} result(s) for ${items.length} item(s). Use Sequentially or Transaction mode instead.`,
			);
		}
		return items.flatMap((_, i) => mapSingleResult(results[i], i));
	} catch (error) {
		if (context.continueOnFail()) {
			const message = (error as Error).message;
			return items.map((_, i) => ({ json: { error: message }, pairedItem: { item: i } }));
		}
		throw toNodeOperationError(context, error, 0);
	}
}

/**
 * Executes the "Execute Query" operation for all n8n input items.
 *
 * Dispatches to one of three execution strategies based on the executionMode
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
	// executionMode and restrictToSelect are both noDataExpression: true — same for all items;
	// safe to read once at index 0 instead of per item.
	const executionMode = this.getNodeParameter('executionMode', 0, 'sequentially') as string;
	const restrictToSelect = this.getNodeParameter('restrictToSelect', 0, true) as boolean;

	if (executionMode === 'transaction') {
		return executeTransaction(this, driver, items, restrictToSelect);
	}
	if (executionMode === 'single') {
		return executeBatched(this, driver, items, restrictToSelect);
	}
	return executeSequentially(this, driver, items, restrictToSelect);
}
