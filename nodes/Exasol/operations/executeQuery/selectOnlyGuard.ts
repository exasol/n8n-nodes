/**
 * Reserved Exasol keywords whose presence anywhere in a query — outside a string literal, quoted
 * identifier, or comment — means the query is not a plain read-only SELECT. Confirmed RESERVED in
 * `EXA_SQL_KEYWORDS` against a live Exasol instance (2026-07-10): a reserved word can never be
 * used unquoted as an identifier (column/table/alias name), so a bare occurrence of one of these
 * can only be that keyword being used, never a legitimate identifier — regardless of where in the
 * query it appears, whether inside a CTE, a subquery, or after a UNION. This is what lets
 * assertSelectOnly() below skip parsing the query's structure entirely: it doesn't need to know
 * whether a keyword is "the leading statement" or nested three levels deep, only whether it's
 * present at all.
 *
 * `INTO` is included so `SELECT ... INTO <table> FROM ...` — which creates and populates a table
 * despite starting with SELECT (docs.exasol.com/db/latest/sql/select_into.htm) — is rejected the
 * same way as any other disqualifying keyword, without needing special-case handling.
 *
 * This is a lexical heuristic, not a full SQL parse, and its safety rests entirely on every entry
 * here actually being reserved. If one of these ever stopped being reserved in some future Exasol
 * version, the failure mode is over-rejection (blocking a legitimate query that happens to use the
 * word as an identifier) — never under-rejection: assertSelectOnly() also separately requires an
 * explicit SELECT token to be present, so a statement type not covered by this list at all (e.g. a
 * non-reserved keyword) is already rejected for lacking SELECT, not waved through.
 */
const PROHIBITED_KEYWORDS: ReadonlySet<string> = new Set([
	'INSERT',
	'UPDATE',
	'DELETE',
	'MERGE',
	'CREATE',
	'DROP',
	'ALTER',
	'TRUNCATE',
	'GRANT',
	'REVOKE',
	'CALL',
	'INTO',
]);

enum ScanState {
	Normal,
	String,
	Identifier,
	LineComment,
	BlockComment,
}

interface StripResult {
	/** Same length as the input; string/identifier literals and comments are blanked to spaces. */
	cleaned: string;
	/** False when the query ends still inside a string/identifier/comment (malformed input). */
	terminatedCleanly: boolean;
}

/**
 * Strips string literals ('...'), quoted identifiers ("..."), line comments (--...), and block
 * comments (/* ... *\/) out of `query`, replacing their contents with spaces. Feeds the keyword
 * scan in assertSelectOnly() below, so a keyword appearing inside a string/identifier/comment
 * (e.g. a WHERE clause literal containing the word "INSERT") is invisible to it rather than merely
 * "not matched".
 *
 * This has to run as a single left-to-right state machine over the whole string, not as four
 * independent regex passes (one per literal/comment kind). An embedded quote of one kind inside a
 * legally-quoted span of the other kind — e.g. the identifier "o'brien_table" — would make an
 * isolated regex for the other quote type close in the wrong place and silently blank real SQL
 * text between two unrelated quotes elsewhere in the string. Doubled-quote escaping ('' inside a
 * string, "" inside an identifier) mirrors the same rule quoteLiteral()/quoteIdentifier() in
 * shared/whereBuilder.ts use when producing these literals.
 */
function stripLiteralsAndComments(query: string): StripResult {
	const cleaned: string[] = [];
	let state: ScanState = ScanState.Normal;
	let i = 0;

	function consume(count: number): void {
		for (let k = 0; k < count; k++) {
			cleaned.push(' ');
		}
		i += count;
	}

	while (i < query.length) {
		const ch = query[i];
		const next = query[i + 1];

		if (state === ScanState.Normal) {
			if (ch === "'") {
				state = ScanState.String;
				consume(1);
			} else if (ch === '"') {
				state = ScanState.Identifier;
				consume(1);
			} else if (ch === '-' && next === '-') {
				state = ScanState.LineComment;
				consume(2);
			} else if (ch === '/' && next === '*') {
				state = ScanState.BlockComment;
				consume(2);
			} else {
				cleaned.push(ch);
				i++;
			}
			continue;
		}

		if (state === ScanState.String) {
			if (ch === "'" && next === "'") {
				consume(2);
			} else if (ch === "'") {
				state = ScanState.Normal;
				consume(1);
			} else {
				consume(1);
			}
			continue;
		}

		if (state === ScanState.Identifier) {
			if (ch === '"' && next === '"') {
				consume(2);
			} else if (ch === '"') {
				state = ScanState.Normal;
				consume(1);
			} else {
				consume(1);
			}
			continue;
		}

		if (state === ScanState.LineComment) {
			if (ch === '\n') {
				state = ScanState.Normal;
				cleaned.push('\n');
				i++;
			} else {
				consume(1);
			}
			continue;
		}

		// BlockComment. Exasol block comments do not nest — like virtually every SQL dialect
		// (unlike C), the *first* "*/" closes the comment.
		if (ch === '*' && next === '/') {
			state = ScanState.Normal;
			consume(2);
		} else {
			consume(1);
		}
	}

	// A line comment naturally extends to end-of-input with no closing delimiter needed — that's
	// not malformed, unlike an unterminated string/identifier/block comment.
	const terminatedCleanly = state === ScanState.Normal || state === ScanState.LineComment;
	return { cleaned: cleaned.join(''), terminatedCleanly };
}

/**
 * Finds every alphabetic token in `cleaned`, uppercased. Matching is always whole-token: the
 * regex greedily consumes an entire identifier (e.g. `INTO_SUMMARY`), so it is compared as one
 * unit against PROHIBITED_KEYWORDS rather than via substring matching — a column or CTE named
 * `INTO_SUMMARY` or `SELECTOR` is never mistaken for the keyword it contains.
 */
function extractTokens(cleaned: string): string[] {
	const tokens: string[] = [];
	const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
	let match: RegExpExecArray | null;
	while ((match = wordRe.exec(cleaned)) !== null) {
		tokens.push(match[0].toUpperCase());
	}
	return tokens;
}

/**
 * Rejects any query that is not entirely read-only `SELECT` (or `WITH ... SELECT`) content — the
 * mitigation for Execute Query being freeform SQL text reachable by an AI agent (the node is
 * `usableAsTool: true`). Intended to be called only when the "Restrict to SELECT Queries" node
 * parameter is enabled; the caller (executeQuery/execute.ts) is responsible for that gating and
 * for wrapping the plain `Error` thrown here into a `NodeOperationError` with itemIndex context,
 * the same pattern `upsert/mergeBuilder.ts`'s validation functions use.
 *
 * A query passes only if it contains a `SELECT` token and none of PROHIBITED_KEYWORDS, checked
 * without regard to where in the query they appear — see PROHIBITED_KEYWORDS' doc comment for why
 * that's sound (every entry is a reserved word, so it can only ever be its own keyword, never an
 * identifier) and why it makes structural analysis (nesting, CTE boundaries, statement position)
 * unnecessary. Deliberately does not reject multiple `;`-separated statements: today, Exasol's
 * `execute` command already rejects a multi-statement `sqlText` server-side with a syntax error
 * (verified empirically), so it isn't reachable in practice — but if that ever changed, several
 * `;`-separated statements that each individually pass this same check (i.e. are themselves plain
 * SELECTs) are no more dangerous than one.
 *
 * Not covered: a SELECT that invokes a UDF/script (e.g. `SELECT my_udf(x) FROM t`) passes this
 * check even if the script's own body has side effects — lexically it's still a plain SELECT.
 * In practice this is only a theoretical concern, since UDF scripts normally have no access to
 * the database (they run in a sandboxed container without a connection back to Exasol) — but a
 * script explicitly granted that access, or one that reaches out over the network / BucketFS,
 * would not be caught here. Closing this gap would require restricting the credential's DB user
 * privileges rather than anything this lexical scan could do.
 *
 * @throws Error when the query is not recognizable as read-only SELECT content
 */
export function assertSelectOnly(query: string): void {
	const { cleaned, terminatedCleanly } = stripLiteralsAndComments(query);
	if (!terminatedCleanly) {
		throw new Error(
			'Restrict to SELECT Queries could not parse this query: it contains an unterminated ' +
				'string literal, quoted identifier, or comment.',
		);
	}

	const tokens = extractTokens(cleaned);
	const hasSelect = tokens.includes('SELECT');
	const hasProhibitedKeyword = tokens.some((token) => PROHIBITED_KEYWORDS.has(token));

	if (!hasSelect || hasProhibitedKeyword) {
		throw new Error(
			'Restrict to SELECT Queries is enabled, but this query is not recognized as a SELECT ' +
				'(or WITH ... SELECT) statement.',
		);
	}
}
