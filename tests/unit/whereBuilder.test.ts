import {
	buildWhereClause,
	buildWhereClauseLiteral,
	quoteIdentifier,
	quoteLiteral,
} from '../../nodes/Exasol/operations/shared/whereBuilder';
import type { WhereCondition } from '../../nodes/Exasol/operations/shared/whereBuilder';

describe('quoteIdentifier()', () => {
	it('wraps the identifier in double quotes', () => {
		expect(quoteIdentifier('MY_COLUMN')).toBe('"MY_COLUMN"');
	});

	it('preserves mixed case', () => {
		expect(quoteIdentifier('MyColumn')).toBe('"MyColumn"');
	});

	it('escapes an embedded double quote by doubling it', () => {
		expect(quoteIdentifier('WEIRD"COLUMN')).toBe('"WEIRD""COLUMN"');
	});
});

describe('buildWhereClause()', () => {
	it('returns an empty clause and no params for an empty condition list', () => {
		const result = buildWhereClause([]);

		expect(result).toEqual({ clause: '', params: [] });
	});

	it('builds a single equals condition', () => {
		const conditions: WhereCondition[] = [{ column: 'ID', operator: 'equals', value: 1 }];

		const result = buildWhereClause(conditions);

		expect(result.clause).toBe('WHERE "ID" = ?');
		expect(result.params).toEqual([1]);
	});

	it.each([
		['equals', '='],
		['notEquals', '!='],
		['lessThan', '<'],
		['lessThanOrEqual', '<='],
		['greaterThan', '>'],
		['greaterThanOrEqual', '>='],
		['like', 'LIKE'],
		['notLike', 'NOT LIKE'],
		['regexpLike', 'REGEXP_LIKE'],
		['notRegexpLike', 'NOT REGEXP_LIKE'],
	] as const)('maps operator %s to SQL "%s"', (operator, sql) => {
		const result = buildWhereClause([{ column: 'NAME', operator, value: 'x' }]);

		expect(result.clause).toBe(`WHERE "NAME" ${sql} ?`);
		expect(result.params).toEqual(['x']);
	});

	it('renders IS NULL with no bound parameter', () => {
		const result = buildWhereClause([{ column: 'NAME', operator: 'isNull' }]);

		expect(result.clause).toBe('WHERE "NAME" IS NULL');
		expect(result.params).toEqual([]);
	});

	it('renders IS NOT NULL with no bound parameter', () => {
		const result = buildWhereClause([{ column: 'NAME', operator: 'isNotNull' }]);

		expect(result.clause).toBe('WHERE "NAME" IS NOT NULL');
		expect(result.params).toEqual([]);
	});

	it('ignores a provided value for IS NULL', () => {
		const result = buildWhereClause([{ column: 'NAME', operator: 'isNull', value: 'ignored' }]);

		expect(result.clause).toBe('WHERE "NAME" IS NULL');
		expect(result.params).toEqual([]);
	});

	it('joins multiple conditions with AND by default', () => {
		const conditions: WhereCondition[] = [
			{ column: 'A', operator: 'equals', value: 1 },
			{ column: 'B', operator: 'equals', value: 2 },
		];

		const result = buildWhereClause(conditions);

		expect(result.clause).toBe('WHERE "A" = ? AND "B" = ?');
		expect(result.params).toEqual([1, 2]);
	});

	it('joins multiple conditions with OR when requested', () => {
		const conditions: WhereCondition[] = [
			{ column: 'A', operator: 'equals', value: 1 },
			{ column: 'B', operator: 'equals', value: 2 },
		];

		const result = buildWhereClause(conditions, 'OR');

		expect(result.clause).toBe('WHERE "A" = ? OR "B" = ?');
		expect(result.params).toEqual([1, 2]);
	});

	it('binds params in the same left-to-right order as the conditions, skipping nullary operators', () => {
		const conditions: WhereCondition[] = [
			{ column: 'A', operator: 'equals', value: 'a' },
			{ column: 'B', operator: 'isNull' },
			{ column: 'C', operator: 'like', value: '%c%' },
		];

		const result = buildWhereClause(conditions);

		expect(result.clause).toBe('WHERE "A" = ? AND "B" IS NULL AND "C" LIKE ?');
		expect(result.params).toEqual(['a', '%c%']);
	});

	it('quotes column identifiers, escaping embedded double quotes', () => {
		const result = buildWhereClause([{ column: 'WEIRD"COL', operator: 'equals', value: 1 }]);

		expect(result.clause).toBe('WHERE "WEIRD""COL" = ?');
	});

	// ── Injection hardening ──────────────────────────────────────────────────────
	// combinator and operator are concatenated straight into the SQL text (neither is quoted as
	// an identifier nor bound as a `?` value), so they must be validated against an allow-list —
	// their declared 'AND' | 'OR' / WhereOperator types are UI hints an n8n expression can bypass
	// at runtime, not a runtime guarantee.

	it('rejects a combinator that is not AND or OR', () => {
		const conditions: WhereCondition[] = [{ column: 'A', operator: 'equals', value: 1 }];

		expect(() => buildWhereClause(conditions, '1=1; DROP SCHEMA X CASCADE; --')).toThrow(
			/Invalid Where combinator/,
		);
	});

	it('rejects a non-string combinator', () => {
		const conditions: WhereCondition[] = [{ column: 'A', operator: 'equals', value: 1 }];

		expect(() => buildWhereClause(conditions, 42)).toThrow(/Invalid Where combinator/);
	});

	it('rejects an operator outside the known allow-list', () => {
		const conditions = [{ column: 'A', operator: '1=1 OR "A" = ?' }] as unknown as WhereCondition[];

		expect(() => buildWhereClause(conditions)).toThrow(/Invalid Where operator/);
	});

	it('rejects an operator that collides with an inherited Object property name', () => {
		// A plain-object lookup like OPERATOR_SQL['__proto__'] resolves through the prototype
		// chain instead of returning undefined; KNOWN_OPERATORS.has(...) must reject it outright
		// rather than silently falling through to a lookup.
		const conditions = [{ column: 'A', operator: '__proto__' }] as unknown as WhereCondition[];

		expect(() => buildWhereClause(conditions)).toThrow(/Invalid Where operator/);
	});

	it('rejects an empty Where column', () => {
		const conditions: WhereCondition[] = [{ column: '', operator: 'equals', value: 1 }];

		expect(() => buildWhereClause(conditions)).toThrow(/Where column must be a non-empty string/);
	});

	it('rejects a whitespace-only Where column', () => {
		const conditions: WhereCondition[] = [{ column: '   ', operator: 'equals', value: 1 }];

		expect(() => buildWhereClause(conditions)).toThrow(/Where column must be a non-empty string/);
	});

	it('rejects a non-string Where column instead of crashing on .trim()', () => {
		const conditions = [
			{ column: 123, operator: 'equals', value: 1 },
		] as unknown as WhereCondition[];

		expect(() => buildWhereClause(conditions)).toThrow(/Where column must be a non-empty string/);
	});
});

describe('quoteLiteral()', () => {
	it('renders null as the NULL keyword', () => {
		expect(quoteLiteral(null)).toBe('NULL');
	});

	it('renders undefined as the NULL keyword', () => {
		expect(quoteLiteral(undefined)).toBe('NULL');
	});

	it('renders true/false as the TRUE/FALSE keywords', () => {
		expect(quoteLiteral(true)).toBe('TRUE');
		expect(quoteLiteral(false)).toBe('FALSE');
	});

	it('renders a number without quotes', () => {
		expect(quoteLiteral(42)).toBe('42');
		expect(quoteLiteral(-3.5)).toBe('-3.5');
	});

	it('rejects a non-finite number', () => {
		expect(() => quoteLiteral(Infinity)).toThrow(/non-finite number/);
		expect(() => quoteLiteral(NaN)).toThrow(/non-finite number/);
	});

	it('quotes a string and escapes an embedded single quote by doubling it', () => {
		expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
	});

	it('stringifies and quotes a value of another type', () => {
		expect(quoteLiteral(['a', 'b'])).toBe("'a,b'");
	});
});

describe('buildWhereClauseLiteral()', () => {
	it('returns an empty clause for an empty condition list', () => {
		expect(buildWhereClauseLiteral([])).toBe('');
	});

	it('inlines a single equals condition as a literal', () => {
		const result = buildWhereClauseLiteral([{ column: 'ID', operator: 'equals', value: 1 }]);

		expect(result).toBe('WHERE "ID" = 1');
	});

	it('inlines a string value, quoted', () => {
		const result = buildWhereClauseLiteral([{ column: 'NAME', operator: 'equals', value: 'x' }]);

		expect(result).toBe(`WHERE "NAME" = 'x'`);
	});

	it('renders IS NULL with no operand', () => {
		const result = buildWhereClauseLiteral([{ column: 'NAME', operator: 'isNull' }]);

		expect(result).toBe('WHERE "NAME" IS NULL');
	});

	it('joins multiple conditions with AND by default', () => {
		const conditions: WhereCondition[] = [
			{ column: 'A', operator: 'equals', value: 1 },
			{ column: 'B', operator: 'greaterThan', value: 2 },
		];

		expect(buildWhereClauseLiteral(conditions)).toBe('WHERE "A" = 1 AND "B" > 2');
	});

	it('joins multiple conditions with OR when requested', () => {
		const conditions: WhereCondition[] = [
			{ column: 'A', operator: 'equals', value: 1 },
			{ column: 'B', operator: 'equals', value: 2 },
		];

		expect(buildWhereClauseLiteral(conditions, 'OR')).toBe('WHERE "A" = 1 OR "B" = 2');
	});

	it('rejects a combinator that is not AND or OR', () => {
		const conditions: WhereCondition[] = [{ column: 'A', operator: 'equals', value: 1 }];

		expect(() => buildWhereClauseLiteral(conditions, '1=1; DROP SCHEMA X CASCADE; --')).toThrow(
			/Invalid Where combinator/,
		);
	});

	it('rejects an operator outside the known allow-list', () => {
		const conditions = [{ column: 'A', operator: '1=1 OR "A" = ?' }] as unknown as WhereCondition[];

		expect(() => buildWhereClauseLiteral(conditions)).toThrow(/Invalid Where operator/);
	});

	it('rejects an empty Where column', () => {
		const conditions: WhereCondition[] = [{ column: '', operator: 'equals', value: 1 }];

		expect(() => buildWhereClauseLiteral(conditions)).toThrow(/Where column must be a non-empty string/);
	});

	it('quotes column identifiers, escaping embedded double quotes', () => {
		const result = buildWhereClauseLiteral([{ column: 'WEIRD"COL', operator: 'equals', value: 1 }]);

		expect(result).toBe('WHERE "WEIRD""COL" = 1');
	});
});
