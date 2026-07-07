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
 * Wraps a SQL identifier (schema, table, or column name) in double quotes so Exasol preserves
 * its case instead of folding it to uppercase, and so it can't be misread as a keyword.
 * Embedded double quotes are escaped by doubling, per Exasol's identifier-quoting rule — this
 * also stops a user-supplied identifier (e.g. a typed-in column name) from breaking out of the
 * quotes to inject arbitrary SQL, since identifiers can't otherwise be bound as `?` parameters.
 */
export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Builds a parameterized WHERE clause from the "Where" fixed-collection parameter. Each
 * condition becomes `"column" OP ?` (or `"column" OP` for IS NULL / IS NOT NULL, which take no
 * value), joined by `combinator`.
 *
 * `combinator` and each condition's `operator` are typed loosely (`unknown`) even though the
 * "AND"/"OR" and WhereOperator literal unions describe the values n8n's UI can produce — both
 * are also settable via an n8n expression, which can resolve to any string at runtime and
 * bypass those types entirely. Since both are concatenated straight into the SQL text (neither
 * is an identifier that quoteIdentifier() can escape, nor a value that can be bound as `?`),
 * they're validated against an explicit allow-list here instead of trusted at the type level.
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
	if (combinator !== 'AND' && combinator !== 'OR') {
		throw new Error(
			`Invalid Where combinator: ${JSON.stringify(combinator)}. Expected "AND" or "OR".`,
		);
	}

	const params: unknown[] = [];
	const fragments = conditions.map((condition) => {
		if (!KNOWN_OPERATORS.has(condition.operator)) {
			throw new Error(`Invalid Where operator: ${JSON.stringify(condition.operator)}.`);
		}
		// "Column" is required in the UI, which only stops an empty default from being saved —
		// an n8n expression can still resolve it to '' at runtime. Without this guard an empty
		// column would reach quoteIdentifier() unchecked, producing `WHERE "" = ?` and an opaque
		// Exasol syntax error instead of a clear validation message.
		if (!condition.column || !condition.column.trim()) {
			throw new Error('Where column must not be empty.');
		}
		const column = quoteIdentifier(condition.column);
		const operatorSql = OPERATOR_SQL[condition.operator];
		if (NULLARY_OPERATORS.has(condition.operator)) {
			return `${column} ${operatorSql}`;
		}
		params.push(condition.value);
		return `${column} ${operatorSql} ?`;
	});

	return { clause: `WHERE ${fragments.join(` ${combinator} `)}`, params };
}
