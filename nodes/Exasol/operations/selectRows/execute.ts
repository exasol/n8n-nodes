import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver, SQLQueriesResponse, SQLResponse } from '@exasol/exasol-driver-ts';

import { resultSetToRows } from '../shared/resultMapper';
import type { WhereCondition } from '../shared/whereBuilder';
import { buildWhereClause, quoteIdentifier } from '../shared/whereBuilder';

// Reads the "Where" fixedCollection for one input item. A fixedCollection with
// multipleValues returns { conditions: [...] }, or {} when no rows have been added.
function readWhereConditions(context: IExecuteFunctions, itemIndex: number): WhereCondition[] {
	const collection = context.getNodeParameter('where', itemIndex, {}) as {
		conditions?: WhereCondition[];
	};
	return collection.conditions ?? [];
}

// Reads the "Sort" fixedCollection for one input item, same shape convention as
// readWhereConditions. `direction` is left as `unknown` — its declared 'ASC' | 'DESC' type is a
// UI hint only, not a runtime guarantee (see requireSortDirection below).
function readSortRules(
	context: IExecuteFunctions,
	itemIndex: number,
): Array<{ column: string; direction: unknown }> {
	const collection = context.getNodeParameter('sort', itemIndex, {}) as {
		rules?: Array<{ column: string; direction: unknown }>;
	};
	return collection.rules ?? [];
}

// Schema and Table are marked required in description.ts, which only stops the UI from saving
// an empty default — an n8n expression can still resolve to '' at runtime, so this is validated
// again here (same pattern as executeQuery's readQuery()).
function requireNonEmpty(
	context: IExecuteFunctions,
	value: string,
	fieldLabel: string,
	itemIndex: number,
): string {
	if (!value.trim()) {
		throw new NodeOperationError(context.getNode(), `${fieldLabel} must not be empty`, {
			itemIndex,
		});
	}
	return value;
}

// Limit is concatenated straight into the query text (Exasol's LIMIT doesn't take a bound `?`
// value the same way a WHERE value does), so — like requireSortDirection below — it is
// allow-list-validated here rather than trusted via a `getNodeParameter(...) as number` cast,
// which an n8n expression could bypass at runtime with a non-numeric value.
function requirePositiveInteger(
	context: IExecuteFunctions,
	value: unknown,
	fieldLabel: string,
	itemIndex: number,
): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new NodeOperationError(
			context.getNode(),
			`${fieldLabel} must be a positive integer, got: ${JSON.stringify(value)}`,
			{ itemIndex },
		);
	}
	return value;
}

// ORDER BY direction is a raw SQL keyword, not an identifier (quoteIdentifier doesn't apply) and
// not a bindable value (no `?` placeholder exists for it) — so, like combinator/operator in
// whereBuilder.ts, it's validated against an explicit allow-list instead of trusted via the
// 'ASC' | 'DESC' type an n8n expression can bypass at runtime.
function requireSortDirection(direction: unknown): 'ASC' | 'DESC' {
	if (direction !== 'ASC' && direction !== 'DESC') {
		throw new Error(
			`Invalid Sort direction: ${JSON.stringify(direction)}. Expected "ASC" or "DESC".`,
		);
	}
	return direction;
}

// Assembles the final SELECT statement from its already-parsed pieces. Schema, table, and
// sort-rule columns are identifiers (quoted, never bound); WHERE values are bound via `?`
// and returned separately in whereResult.params for stmt.execute().
function buildSelectQuery(
	schema: string,
	table: string,
	whereClause: string,
	sortRules: Array<{ column: string; direction: unknown }>,
	limit: number | undefined,
): string {
	let query = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
	if (whereClause) {
		query += ` ${whereClause}`;
	}
	if (sortRules.length > 0) {
		const orderBy = sortRules
			.map((rule) => `${quoteIdentifier(rule.column)} ${requireSortDirection(rule.direction)}`)
			.join(', ');
		query += ` ORDER BY ${orderBy}`;
	}
	if (limit !== undefined) {
		query += ` LIMIT ${limit}`;
	}
	return query;
}

// Maps a driver response's first (and only) statement result to output items for one input item.
// A SELECT always yields a resultSet on success; anything else (missing/empty responseData, a
// rowCount-typed result) is treated defensively as zero rows rather than crashing.
function mapSelectResult(
	response: SQLResponse<SQLQueriesResponse>,
	itemIndex: number,
): INodeExecutionData[] {
	if (response.status === 'error') {
		throw new Error(response.exception?.text || 'Select query failed');
	}
	const result = response.responseData?.results?.[0];
	if (result?.resultType !== 'resultSet' || !result.resultSet) return [];
	return resultSetToRows(result.resultSet).map((row) => ({
		json: row,
		pairedItem: { item: itemIndex },
	}));
}

// Runs one SELECT statement. WHERE values (if any) are bound via prepare() + stmt.execute() to
// prevent SQL injection. When there are none, this goes through driver.query(..., 'raw') instead
// of prepare(): the driver's prepare() unconditionally reads
// response.responseData.parameterData.columns, which the server omits entirely for a statement
// with zero `?` placeholders — prepare() throws "Cannot read properties of undefined (reading
// 'columns')" for any parameter-free query. Mirrors the identical raw/parameterized split in
// operations/executeQuery/execute.ts's runQuery().
async function runSelect(
	driver: ExasolDriver,
	query: string,
	params: unknown[],
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	if (params.length === 0) {
		const raw = await driver.query(query, undefined, undefined, 'raw');
		return mapSelectResult(raw, itemIndex);
	}

	const stmt = await driver.prepare(query);
	try {
		const response = await stmt.execute(...params);
		return mapSelectResult(response, itemIndex);
	} finally {
		await stmt.close().catch(() => {});
	}
}

/**
 * Executes the "Select Rows" operation for all n8n input items.
 *
 * Builds and runs one SELECT statement per input item — schema, table, WHERE conditions, sort
 * rules, and limit can all vary per item via n8n expressions, same as every other field read
 * with getNodeParameter(name, itemIndex).
 *
 * Called with `this` bound to IExecuteFunctions so n8n's per-item parameter APIs are available
 * without passing the context explicitly.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param items  - the n8n input items for this execution
 * @returns flat list of INodeExecutionData items, one per selected row
 */
export async function execute(
	this: IExecuteFunctions,
	driver: ExasolDriver,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const returnData: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			const schema = requireNonEmpty(
				this,
				this.getNodeParameter('schema', i) as string,
				'Schema',
				i,
			);
			const table = requireNonEmpty(this, this.getNodeParameter('table', i) as string, 'Table', i);
			const combineConditions = this.getNodeParameter('combineConditions', i, 'AND');
			const where = buildWhereClause(readWhereConditions(this, i), combineConditions);
			const sortRules = readSortRules(this, i);
			const returnAll = this.getNodeParameter('returnAll', i, true) as boolean;
			const limit = returnAll
				? undefined
				: requirePositiveInteger(this, this.getNodeParameter('limit', i, 50), 'Limit', i);

			const query = buildSelectQuery(schema, table, where.clause, sortRules, limit);

			returnData.push(...(await runSelect(driver, query, where.params, i)));
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
