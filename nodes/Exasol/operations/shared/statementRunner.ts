import type { ExasolDriver } from '@exasol/exasol-driver-ts';

/**
 * Runs a single prepared statement via prepare() + stmt.execute(), which prevents SQL injection
 * on the bound values (identifiers must be quoted separately by the caller via quoteIdentifier).
 * A missing rowCount is treated as zero affected rows rather than crashing.
 *
 * Shared by every write operation (Insert, Update, and — in later PRs — Delete, Upsert), which
 * otherwise differ only in how the query and params are built and in the fallback error text.
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
		if (response.status === 'error') {
			throw new Error(response.exception?.text || failureMessage);
		}
		return response.responseData?.results?.[0]?.rowCount ?? 0;
	} finally {
		await stmt.close().catch(() => {});
	}
}
