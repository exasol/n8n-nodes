import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver, SQLQueriesResponse, SQLResponse } from '@exasol/exasol-driver-ts';

import { resultSetToRows, type ExasolColumnValue } from './resultMapper';

/**
 * Checks a driver response for an error status or a missing responseData (a malformed/short
 * response — e.g. a network hiccup — that isn't reported as status 'error' but still can't be
 * trusted), then extracts the affected row count. A missing rowCount on an otherwise-valid
 * response is treated as zero affected rows rather than crashing.
 *
 * Shared by runStatement() and runRawStatement(), which differ only in how they obtain the
 * response (prepared stmt.execute() vs unprepared driver.query()).
 *
 * @param response - the driver's response to an executed statement
 * @param failureMessage - fallback error text used when the driver reports an error without one,
 * or reports success with no responseData at all
 * @returns number of rows affected by the statement
 */
function interpretResponse(
	response: SQLResponse<SQLQueriesResponse>,
	failureMessage: string,
): number {
	if (response.status === 'error') {
		throw new Error(response.exception?.text || failureMessage);
	}
	if (!response.responseData) {
		throw new Error(failureMessage);
	}
	return response.responseData.results?.[0]?.rowCount ?? 0;
}

/**
 * Runs a single prepared statement via prepare() + stmt.execute(), which prevents SQL injection
 * on the bound values (identifiers must be quoted separately by the caller via quoteIdentifier).
 *
 * Shared by every write operation (Insert, Update, and — in later PRs — Upsert), which otherwise
 * differ only in how the query and params are built and in the fallback error text.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param query - the prepared statement text
 * @param params - bound values in placeholder order
 * @param failureMessage - fallback error text used when the driver reports an error without one
 * @returns number of rows affected by the statement
 */
export async function runStatement(
	driver: ExasolDriver,
	query: string,
	params: unknown[],
	failureMessage: string,
): Promise<number> {
	const stmt = await driver.prepare(query);
	try {
		const response = await stmt.execute(...params);
		return interpretResponse(response, failureMessage);
	} finally {
		await stmt.close().catch(() => {});
	}
}

/**
 * Runs a statement with no bound parameters via driver.query(..., 'raw') instead of
 * prepare() + stmt.execute(). The 'raw' response type returns the full SQLResponse (status,
 * exception, responseData) instead of throwing on a non-SELECT result, mirroring the no-params
 * path in executeQuery/execute.ts.
 *
 * Used by Delete, whose WHERE values are inlined as literals rather than bound — see
 * buildWhereClauseLiteral() in whereBuilder.ts for why a prepared statement won't work there.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param query - the statement text, with any values already inlined as literals
 * @param failureMessage - fallback error text used when the driver reports an error without one
 * @returns number of rows affected by the statement
 */
export async function runRawStatement(
	driver: ExasolDriver,
	query: string,
	failureMessage: string,
): Promise<number> {
	const response = await driver.query(query, undefined, undefined, 'raw');
	return interpretResponse(response, failureMessage);
}

/** One row of a SELECT-style result, already pivoted to a plain object keyed by column name. */
export type QueryRow = Record<string, ExasolColumnValue>;

/**
 * Runs one statement via prepare() + stmt.execute() when params are given, or
 * driver.query(..., 'raw') when there are none, and returns the driver's raw response for the
 * caller to interpret. A parameter-free query must skip prepare(): prepare() unconditionally
 * reads response.responseData.parameterData.columns, which the server omits entirely when there
 * are no `?` placeholders, so a parameter-free prepare() throws "Cannot read properties of
 * undefined (reading 'columns')".
 *
 * Shared low-level primitive for every SELECT/DML caller in this codebase — Schema Explorer,
 * selectRows/execute.ts's runSelect(), and executeQuery/execute.ts's runQuery() all hit this same
 * driver quirk and differ only in how they interpret the resulting response.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param query - the statement text
 * @param params - bound values in placeholder order; pass [] for a parameter-free query
 * @returns the driver's raw response, uninterpreted
 */
export async function runRawOrPrepared(
	driver: ExasolDriver,
	query: string,
	params: unknown[],
): Promise<SQLResponse<SQLQueriesResponse>> {
	if (params.length === 0) {
		return driver.query(query, undefined, undefined, 'raw');
	}
	const stmt = await driver.prepare(query);
	try {
		return await stmt.execute(...params);
	} finally {
		await stmt.close().catch(() => {});
	}
}

/**
 * Runs one SELECT-style statement and returns its rows already pivoted to row-major objects (via
 * resultSetToRows), leaving it to the caller to decide how many output items those rows become —
 * a 1:1 row-to-item mapping is the common case, but e.g. Describe Table's constraints query
 * collapses multiple rows into a single summary item.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param query - the statement text
 * @param params - bound values in placeholder order; pass [] for a parameter-free query
 * @returns rows pivoted to row-major objects, or [] when the response is valid but carries no
 * result set (e.g. a non-SELECT statement)
 * @throws when the driver reports an error status, or when responseData is missing entirely (e.g.
 * a network hiccup) — neither is treated as zero rows, so a real failure can't be mistaken for an
 * empty result
 */
export async function runRows(
	driver: ExasolDriver,
	query: string,
	params: unknown[],
): Promise<QueryRow[]> {
	const response = await runRawOrPrepared(driver, query, params);

	if (response.status === 'error') {
		throw new Error(response.exception?.text || 'Query failed');
	}
	// A missing responseData (e.g. a network hiccup) isn't reported as status 'error' but still
	// can't be trusted — treating it as "no rows" would mask the failure as an empty result.
	if (!response.responseData) {
		throw new Error('Query returned no response data');
	}
	const result = response.responseData.results?.[0];
	if (result?.resultType !== 'resultSet' || !result.resultSet) return [];
	return resultSetToRows(result.resultSet);
}

/**
 * Wraps runRows() with the "(query: ...)" error-text convention and NodeOperationError itemIndex
 * tagging used by every operation's per-item error handling, so a failure like "table not found"
 * identifies which query caused it.
 *
 * @param context - the executing operation's IExecuteFunctions, for getNode()
 * @param driver - an already-connected ExasolDriver instance
 * @param query - the statement text
 * @param params - bound values in placeholder order; pass [] for a parameter-free query
 * @param itemIndex - the input item this query is running for
 * @returns rows pivoted to row-major objects, or [] when the response is valid but carries no
 * result set (e.g. a non-SELECT statement)
 * @throws NodeOperationError when the driver reports an error status, or when responseData is
 * missing entirely (e.g. a network hiccup) — neither is treated as zero rows
 */
export async function runQuery(
	context: IExecuteFunctions,
	driver: ExasolDriver,
	query: string,
	params: unknown[],
	itemIndex: number,
): Promise<QueryRow[]> {
	try {
		return await runRows(driver, query, params);
	} catch (error) {
		throw new NodeOperationError(
			context.getNode(),
			`${(error as Error).message} (query: ${query})`,
			{ itemIndex },
		);
	}
}
