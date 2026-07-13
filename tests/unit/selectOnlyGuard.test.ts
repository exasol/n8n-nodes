import { assertSelectOnly } from '../../nodes/Exasol/operations/executeQuery/selectOnlyGuard';

const NOT_A_SELECT = /not recognized as a SELECT/;

describe('assertSelectOnly()', () => {
	// ── Plain SELECT ─────────────────────────────────────────────────────────────
	describe('plain SELECT', () => {
		it('allows a simple SELECT', () => {
			expect(() => assertSelectOnly('SELECT * FROM t')).not.toThrow();
		});

		it('allows lowercase select', () => {
			expect(() => assertSelectOnly('select * from t')).not.toThrow();
		});

		it('allows mixed-case Select', () => {
			expect(() => assertSelectOnly('SeLeCt 1')).not.toThrow();
		});

		it('allows leading/trailing whitespace', () => {
			expect(() => assertSelectOnly('   SELECT 1   ')).not.toThrow();
		});

		it('allows a trailing semicolon', () => {
			expect(() => assertSelectOnly('SELECT 1;')).not.toThrow();
		});

		it('allows multiple SELECT statements separated by semicolons', () => {
			// Not currently reachable — Exasol's execute command rejects multi-statement sqlText
			// server-side — but not this guard's job to enforce: several statements that are each
			// individually a plain SELECT are no more dangerous than one.
			expect(() => assertSelectOnly('SELECT 1; SELECT 2')).not.toThrow();
		});

		it('allows a nested subquery in the select list', () => {
			expect(() =>
				assertSelectOnly('SELECT a, (SELECT COUNT(*) FROM b) AS c FROM t'),
			).not.toThrow();
		});
	});

	// ── WITH ... SELECT (CTEs) ───────────────────────────────────────────────────
	describe('WITH ... SELECT', () => {
		it('allows a single CTE', () => {
			expect(() => assertSelectOnly('WITH cte AS (SELECT 1 AS n) SELECT * FROM cte')).not.toThrow();
		});

		it('allows multiple CTEs', () => {
			expect(() =>
				assertSelectOnly('WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b'),
			).not.toThrow();
		});

		it('allows a CTE with an explicit column list', () => {
			expect(() =>
				assertSelectOnly('WITH a(col1, col2) AS (SELECT 1, 2) SELECT * FROM a'),
			).not.toThrow();
		});
	});

	// ── SELECT ... INTO rejection ────────────────────────────────────────────────
	describe('SELECT ... INTO rejection', () => {
		it('rejects SELECT ... INTO', () => {
			expect(() => assertSelectOnly('SELECT a, b INTO new_table FROM t')).toThrow(NOT_A_SELECT);
		});

		it('rejects SELECT ... INTO with a WHERE clause', () => {
			expect(() => assertSelectOnly('SELECT a INTO new_table FROM t WHERE x = 1')).toThrow(
				NOT_A_SELECT,
			);
		});

		it('rejects SELECT ... INTO appearing after a UNION', () => {
			expect(() =>
				assertSelectOnly('SELECT a FROM t1 UNION SELECT b INTO new_table FROM t2'),
			).toThrow(NOT_A_SELECT);
		});
	});

	// ── Non-SELECT rejection ─────────────────────────────────────────────────────
	// Each of these keywords is confirmed RESERVED in Exasol (via EXA_SQL_KEYWORDS against a live
	// instance), so its bare presence can only be its own keyword usage — see PROHIBITED_KEYWORDS'
	// doc comment in selectOnlyGuard.ts. That's also why these tests don't check *where* in the
	// query the keyword appears: presence anywhere is disqualifying.
	describe('non-SELECT statements are rejected', () => {
		it('rejects INSERT', () => {
			expect(() => assertSelectOnly('INSERT INTO t VALUES (1)')).toThrow(NOT_A_SELECT);
		});

		it('rejects UPDATE', () => {
			expect(() => assertSelectOnly('UPDATE t SET a = 1')).toThrow(NOT_A_SELECT);
		});

		it('rejects DELETE', () => {
			expect(() => assertSelectOnly('DELETE FROM t')).toThrow(NOT_A_SELECT);
		});

		it('rejects CREATE', () => {
			expect(() => assertSelectOnly('CREATE TABLE t (id INTEGER)')).toThrow(NOT_A_SELECT);
		});

		it('rejects DROP', () => {
			expect(() => assertSelectOnly('DROP TABLE t')).toThrow(NOT_A_SELECT);
		});

		it('rejects MERGE', () => {
			expect(() =>
				assertSelectOnly('MERGE INTO t USING (VALUES (1)) src(a) ON t.a = src.a'),
			).toThrow(NOT_A_SELECT);
		});

		it('rejects TRUNCATE', () => {
			expect(() => assertSelectOnly('TRUNCATE TABLE t')).toThrow(NOT_A_SELECT);
		});

		it('rejects GRANT', () => {
			expect(() => assertSelectOnly('GRANT SELECT ON t TO user')).toThrow(NOT_A_SELECT);
		});

		it('rejects CALL', () => {
			expect(() => assertSelectOnly('CALL my_script()')).toThrow(NOT_A_SELECT);
		});
	});

	// ── CTE-prefixed non-SELECT rejection ────────────────────────────────────────
	// Exasol's grammar actually rejects a CTE preceding any non-SELECT statement outright (a
	// "WITH" clause may only precede a SELECT) — verified directly against a live instance. These
	// cases can therefore never reach the driver regardless of this guard. They're still tested
	// here because assertSelectOnly() is a pure text classifier with no awareness of Exasol's
	// grammar, and correctly rejecting them doesn't depend on that grammar rule holding.
	describe('CTE-prefixed non-SELECT statements are rejected', () => {
		it('rejects WITH ... INSERT', () => {
			expect(() =>
				assertSelectOnly('WITH src AS (SELECT 1) INSERT INTO t SELECT * FROM src'),
			).toThrow(NOT_A_SELECT);
		});

		it('rejects WITH ... DELETE', () => {
			expect(() =>
				assertSelectOnly('WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)'),
			).toThrow(NOT_A_SELECT);
		});

		it('rejects WITH ... UPDATE', () => {
			expect(() => assertSelectOnly('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toThrow(NOT_A_SELECT);
		});

		it('rejects WITH ... MERGE', () => {
			expect(() =>
				assertSelectOnly(
					'WITH x AS (SELECT 1 AS a) MERGE INTO t USING (VALUES (1)) src(a) ON t.a = src.a',
				),
			).toThrow(NOT_A_SELECT);
		});
	});

	// ── False-positive avoidance ──────────────────────────────────────────────────
	describe('does not misread keywords appearing in literals, identifiers, or comments', () => {
		it('ignores a fake keyword inside a string literal', () => {
			expect(() => assertSelectOnly("SELECT * FROM t WHERE name = 'INSERT INTO fake'")).not.toThrow();
		});

		it('ignores a fake keyword inside a string literal containing a doubled quote', () => {
			expect(() =>
				assertSelectOnly("SELECT * FROM t WHERE name = 'it''s a DROP TABLE test'"),
			).not.toThrow();
		});

		it('ignores a fake keyword inside a double-quoted identifier', () => {
			expect(() => assertSelectOnly('SELECT * FROM "INSERT INTO WEIRD TABLE"')).not.toThrow();
		});

		it('handles a doubled double-quote escape inside an identifier', () => {
			expect(() => assertSelectOnly('SELECT * FROM "weird ""quoted"" table"')).not.toThrow();
		});

		it('does not let an embedded single quote inside an identifier corrupt the scan', () => {
			// Regression case: an isolated single-quote-literal regex run independently of the
			// double-quote handling would treat the ' inside "o'brien_table" as opening a string
			// and incorrectly close on the real 'x' literal's opening quote, blanking the WHERE
			// keyword in between.
			expect(() => assertSelectOnly("SELECT * FROM \"o'brien_table\" WHERE name = 'x'")).not.toThrow();
		});

		it('ignores a fake keyword inside a line comment', () => {
			expect(() => assertSelectOnly('SELECT * FROM t -- DROP TABLE t\n WHERE x = 1')).not.toThrow();
		});

		it('ignores a fake keyword inside a block comment', () => {
			expect(() => assertSelectOnly('SELECT * FROM t /* DROP TABLE t */ WHERE x = 1')).not.toThrow();
		});

		it('does not mistake an identifier containing a keyword as a substring for the keyword itself', () => {
			expect(() => assertSelectOnly('SELECT INTO_SUMMARY AS COL FROM t')).not.toThrow();
		});
	});

	// ── Edge cases ────────────────────────────────────────────────────────────────
	describe('edge cases', () => {
		it('rejects an empty query', () => {
			expect(() => assertSelectOnly('')).toThrow(NOT_A_SELECT);
		});

		it('rejects a whitespace-only query', () => {
			expect(() => assertSelectOnly('   \n\t')).toThrow(NOT_A_SELECT);
		});

		it('rejects a comment-only query', () => {
			expect(() => assertSelectOnly('-- just a comment')).toThrow(NOT_A_SELECT);
		});

		it('rejects an unterminated block comment', () => {
			expect(() => assertSelectOnly('SELECT * FROM t /* oops')).toThrow(/could not parse this query/);
		});

		it('rejects an unterminated string literal', () => {
			expect(() => assertSelectOnly("SELECT * FROM t WHERE name = 'oops")).toThrow(
				/could not parse this query/,
			);
		});

		it('rejects a stacked query mixing a SELECT with a prohibited statement', () => {
			// Semicolons aren't special-cased — DROP is still caught anywhere in the token stream.
			expect(() => assertSelectOnly('SELECT 1; DROP TABLE t')).toThrow(NOT_A_SELECT);
		});
	});
});
