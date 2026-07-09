import type { ExasolDriver, SQLQueriesResponse, SQLResponse } from '@exasol/exasol-driver-ts';

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
