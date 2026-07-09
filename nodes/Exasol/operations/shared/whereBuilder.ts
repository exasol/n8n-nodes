import type { IExecuteFunctions } from 'n8n-workflow';

/**
 * Comparison operators exposed by the "Where" fixed-collection field used by Select Rows,
 * and (in later PRs) Update and Delete. Values match the `value`s of the "Operator" dropdown
 * in each operation's description.ts.
 */
export type WhereOperator =
	| 'equals'
	| 'notEquals'
	| 'lessThan'
	| 'lessThanOrEqual'
	| 'greaterThan'
	| 'greaterThanOrEqual'
	| 'like'
	| 'notLike'
	| 'regexpLike'
	| 'notRegexpLike'
	| 'isNull'
	| 'isNotNull';

/**
 * One row of the "Where" fixed-collection parameter. `value` is read but ignored for the
 * nullary operators (`isNull` / `isNotNull`), which take no operand.
 */
export interface WhereCondition {
	column: string;
	operator: WhereOperator;
	value?: unknown;
}

export interface WhereClauseResult {
	/** SQL fragment starting with "WHERE", or "" when no conditions were given. */
	clause: string;
	/** Bound values, in the same left-to-right order as the ? placeholders in `clause`. */
	params: unknown[];
}

const OPERATOR_SQL: Record<WhereOperator, string> = {
	equals: '=',
	notEquals: '!=',
	lessThan: '<',
	lessThanOrEqual: '<=',
	greaterThan: '>',
	greaterThanOrEqual: '>=',
	like: 'LIKE',
	notLike: 'NOT LIKE',
	// Exasol's regex predicate is infix, like LIKE, rather than a function call: it reads
	// "<string> REGEXP_LIKE <pattern>" (or "<string> NOT REGEXP_LIKE <pattern>"), so it slots
	// into the same "column OP ?" template as the other binary operators below.
	regexpLike: 'REGEXP_LIKE',
	notRegexpLike: 'NOT REGEXP_LIKE',
	isNull: 'IS NULL',
	isNotNull: 'IS NOT NULL',
};

const NULLARY_OPERATORS: ReadonlySet<WhereOperator> = new Set(['isNull', 'isNotNull']);

// The "Operator" field's declared type is a UI hint only — an n8n expression can make
// condition.operator resolve to any string at runtime, bypassing the WhereOperator type
// entirely. This Set (built from OPERATOR_SQL's own keys) is checked with .has(), which does
// exact value comparison and never touches the prototype chain — unlike OPERATOR_SQL[operator],
// a bracket lookup on a plain object, which would resolve inherited properties for values like
// '__proto__' or 'toString' instead of returning undefined.
const KNOWN_OPERATORS: ReadonlySet<string> = new Set(Object.keys(OPERATOR_SQL));

/**
 * Reads the "Where" fixedCollection for one input item. A fixedCollection with
 * multipleValues returns { conditions: [...] }, or {} when no rows have been added.
 *
 * Shared by every operation that filters rows with a "Where" collection (Select Rows, Update,
 * and — in later PRs — Delete).
 *
 * @param context - execute context, used to read the node parameter for this item
 * @param itemIndex - index of the input item being processed
 * @returns the configured WHERE conditions, or an empty array if none were added
 */
export function readWhereConditions(
	context: IExecuteFunctions,
	itemIndex: number,
): WhereCondition[] {
	const collection = context.getNodeParameter('where', itemIndex, {}) as {
		conditions?: WhereCondition[];
	};
	return collection.conditions ?? [];
}

/**
 * Wraps a SQL identifier (schema, table, or column name) in double quotes so Exasol preserves
 * its case instead of folding it to uppercase, and so it can't be misread as a keyword.
 * Embedded double quotes are escaped by doubling, per Exasol's identifier-quoting rule — this
 * also stops a user-supplied identifier (e.g. a typed-in column name) from breaking out of the
 * quotes to inject arbitrary SQL, since identifiers can't otherwise be bound as `?` parameters.
 */
export function quoteIdentifier(identifier: string): string {
	// Sonar prefers String#replaceAll here, but tsconfig.json targets es2019 without the ES2021
	// lib, so replaceAll isn't available; the /g regex below is functionally equivalent.
	return `"${identifier.replace(/"/g, '""')}"`; // NOSONAR
}

/**
 * Renders a JS value as an inline SQL literal, for statements that cannot bind it as a `?`
 * parameter (see buildWhereClauseLiteral() below for why Delete needs this, and mergeBuilder.ts
 * for why Upsert does too). Strings are single-quoted with embedded quotes doubled — the same
 * escaping technique quoteIdentifier() uses for identifiers, applied here to values instead, so a
 * user-supplied value can't break out of the quotes to inject arbitrary SQL. A Date (e.g. from a
 * JSON field an upstream node materialized as an actual Date instance, or a Value/Column
 * expression like ={{ new Date() }}) is rendered as an Exasol-literal timestamp string rather
 * than falling into the generic stringify path below — `String(date)` produces JS's verbose
 * locale-formatted form (e.g. "Wed Jan 15 2025 ..."), which Exasol can't parse as a TIMESTAMP.
 * Anything else that isn't a string/number/boolean/nullish (e.g. a plain object or array, which
 * the "Value" field can produce via an n8n expression) is stringified and quoted the same way as
 * a string, rather than left as `[object Object]` unquoted.
 */
export function quoteLiteral(value: unknown): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	if (typeof value === 'boolean') {
		return value ? 'TRUE' : 'FALSE';
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError(`Cannot inline a non-finite number as a SQL literal: ${value}`);
		}
		return String(value);
	}
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new TypeError('Cannot inline an invalid Date as a SQL literal.');
		}
		// toISOString() is always "YYYY-MM-DDTHH:mm:ss.sssZ" (24 chars, UTC) — reslicing around the
		// "T" and dropping the "Z" gives Exasol's default TIMESTAMP literal format
		// ("YYYY-MM-DD HH24:MI:SS.FF3"), which Exasol implicitly casts against a TIMESTAMP/DATE
		// column the same way it would a manually typed literal.
		const iso = value.toISOString();
		return `'${iso.slice(0, 10)} ${iso.slice(11, 23)}'`;
	}
	// NOSONAR: same /g-regex-instead-of-replaceAll rationale as quoteIdentifier() above.
	return `'${String(value).replace(/'/g, "''")}'`; // NOSONAR
}

/**
 * Validates a "Combine Conditions" value against the AND/OR allow-list. `combinator` is typed
 * loosely (`unknown`) even though the UI only offers "AND"/"OR" — it's also settable via an n8n
 * expression, which can resolve to any string at runtime. Since it's concatenated straight into
 * the SQL text (it isn't an identifier quoteIdentifier() can escape, nor a value that can be
 * bound as `?`), it's checked against an explicit allow-list here instead of trusted at the type
 * level.
 *
 * @throws Error when `combinator` is neither "AND" nor "OR"
 */
function validateCombinator(combinator: unknown): asserts combinator is 'AND' | 'OR' {
	if (combinator !== 'AND' && combinator !== 'OR') {
		throw new Error(
			`Invalid Where combinator: ${JSON.stringify(combinator)}. Expected "AND" or "OR".`,
		);
	}
}

/**
 * Builds one `"column" OP <value>` fragment per condition (or `"column" OP` for IS NULL / IS NOT
 * NULL, which take no value) — the piece shared by both buildWhereClause() (bind-parameter
 * values) and buildWhereClauseLiteral() (inline-literal values). `renderValue` supplies the
 * OP's right-hand side and is the only difference between the two callers.
 *
 * @throws Error when a condition's operator is outside the known allow-list, or its column is empty
 */
function buildConditionFragments(
	conditions: WhereCondition[],
	renderValue: (value: unknown) => string,
): string[] {
	return conditions.map((condition) => {
		if (!KNOWN_OPERATORS.has(condition.operator)) {
			throw new Error(`Invalid Where operator: ${JSON.stringify(condition.operator)}.`);
		}
		// "Column" is typed as a string field in the UI, which only stops an empty default from
		// being saved — an n8n expression can still resolve it to '', a number, or any other type
		// at runtime. Without this guard a non-string would crash on .trim() below with a raw
		// TypeError, and an empty column would reach quoteIdentifier() unchecked, producing
		// `WHERE "" = ?` and an opaque Exasol syntax error — both instead of a clear validation
		// message.
		if (typeof condition.column !== 'string' || !condition.column.trim()) {
			throw new Error('Where column must be a non-empty string.');
		}
		const column = quoteIdentifier(condition.column);
		const operatorSql = OPERATOR_SQL[condition.operator];
		if (NULLARY_OPERATORS.has(condition.operator)) {
			return `${column} ${operatorSql}`;
		}
		return `${column} ${operatorSql} ${renderValue(condition.value)}`;
	});
}

/**
 * Builds a parameterized WHERE clause from the "Where" fixed-collection parameter. Each
 * condition becomes `"column" OP ?` (or `"column" OP` for IS NULL / IS NOT NULL, which take no
 * value), joined by `combinator`.
 *
 * Used by Select Rows and Update, both of which run their statement via prepare() + bound
 * parameters. Delete cannot use this — see buildWhereClauseLiteral() below.
 *
 * @param conditions - one entry per "Where" row; an empty array yields no WHERE clause at all
 * @param combinator - how multiple conditions combine; irrelevant when fewer than two are given
 * @returns clause — SQL fragment starting with "WHERE", or "" when `conditions` is empty
 * @returns params — bound values in the same order as the ? placeholders in `clause`
 */
export function buildWhereClause(
	conditions: WhereCondition[],
	combinator: unknown = 'AND',
): WhereClauseResult {
	if (conditions.length === 0) {
		return { clause: '', params: [] };
	}
	validateCombinator(combinator);

	const params: unknown[] = [];
	const fragments = buildConditionFragments(conditions, (value) => {
		params.push(value);
		return '?';
	});
	const separator = ` ${combinator} `;
	return { clause: `WHERE ${fragments.join(separator)}`, params };
}

/**
 * Builds a WHERE clause with values inlined as SQL literals (via quoteLiteral()) instead of
 * bound `?` placeholders.
 *
 * Exasol's *prepared* DELETE statement only accepts parameterized conditions of the exact shape
 * `<column> = ?` (ANDed together) — anything else, including `>`/`LIKE`/`!=` or an `OR`
 * combinator, is rejected server-side ("Feature not supported: Prepared DELETE with
 * parameterized condition other than <column name> = ? or unsupported type"). That restriction
 * is specific to DELETE — it doesn't apply to UPDATE or SELECT — and it would silently break
 * most of the operator dropdown on the "Where" field (shared with Select Rows and Update) if
 * Delete also bound its WHERE values as `?` through a prepared statement. Delete therefore
 * inlines its WHERE values as literals and runs the statement unprepared, via driver.query().
 *
 * @param conditions - one entry per "Where" row; an empty array yields no WHERE clause at all
 * @param combinator - how multiple conditions combine; irrelevant when fewer than two are given
 * @returns SQL fragment starting with "WHERE", or "" when `conditions` is empty
 */
export function buildWhereClauseLiteral(
	conditions: WhereCondition[],
	combinator: unknown = 'AND',
): string {
	if (conditions.length === 0) {
		return '';
	}
	validateCombinator(combinator);

	const fragments = buildConditionFragments(conditions, quoteLiteral);
	const separator = ` ${combinator} `;
	return `WHERE ${fragments.join(separator)}`;
}
