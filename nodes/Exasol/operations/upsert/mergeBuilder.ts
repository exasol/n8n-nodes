import { findUnknownColumns } from '../shared/columnMappings';
import { quoteIdentifier, quoteLiteral } from '../shared/whereBuilder';

/**
 * Validates conflictColumns against `columns` and returns the columns to update on a match —
 * every mapped column except the conflict columns themselves.
 *
 * "Conflict Columns" is a multi-value string field in the UI, so an n8n expression can still
 * resolve an entry to a non-string, blank, or unmapped value at runtime — none of that is caught
 * by the field's `required: true`, which only stops an empty *default* from being saved.
 *
 * @throws Error when conflictColumns is empty, contains a non-string/blank entry, or names a
 *   column that isn't in `columns`
 */
function updateColumnsFor(columns: string[], conflictColumns: unknown[]): string[] {
	if (conflictColumns.length === 0) {
		throw new Error('At least one Conflict Column is required to build a MERGE statement.');
	}
	if (conflictColumns.some((column) => typeof column !== 'string' || !column.trim())) {
		throw new Error('Conflict Column names must be non-empty strings.');
	}
	const matchColumns = conflictColumns as string[];
	const unknownColumns = findUnknownColumns(matchColumns, columns);
	if (unknownColumns.length > 0) {
		throw new Error(
			`Conflict Column(s) not present in the mapped columns (${columns.join(', ')}): ${unknownColumns.join(', ')}.`,
		);
	}
	return columns.filter((column) => !matchColumns.includes(column));
}

/**
 * Rejects any row whose value is NULL/undefined in a conflict-column position.
 *
 * Exasol's MERGE only permits a plain equivalence (`=`) in the ON clause — no `OR`, no
 * `IS NULL`/`COALESCE`/`NVL` wrapping, nothing beyond `<column> = <column>` per Exasol's own docs
 * (https://docs.exasol.com/db/latest/sql/merge.htm: "In the ON condition, only equivalence
 * conditions (=) are permitted"). That rules out a NULL-safe ON clause at the SQL level: SQL's
 * `NULL = NULL` evaluates to UNKNOWN, not TRUE, so a row with a NULL conflict-column value would
 * otherwise never match an existing row with the same NULL and would silently insert a duplicate
 * on every repeated upsert. Rejecting such rows up front trades that silent duplication for a
 * loud, actionable error.
 *
 * @throws Error naming the row index and conflict column when a row's conflict-column value is
 *   NULL/undefined
 */
function assertNoNullConflictValues(
	columns: string[],
	matchColumns: string[],
	rows: unknown[][],
): void {
	const matchColumnIndexes = matchColumns.map((column) => columns.indexOf(column));
	rows.forEach((row, rowIndex) => {
		matchColumnIndexes.forEach((columnIndex, i) => {
			if (row[columnIndex] === null || row[columnIndex] === undefined) {
				throw new Error(
					`Row ${rowIndex} has no value for Conflict Column "${matchColumns[i]}". Exasol's MERGE ` +
						'ON clause only supports "=", which never matches NULL, so a row with a NULL ' +
						'Conflict Column value cannot be safely upserted — it would insert a duplicate row ' +
						'on every run instead of updating the existing one. Ensure every row has a non-NULL ' +
						'value for each Conflict Column, or choose different Conflict Columns.',
				);
			}
		});
	});
}

/**
 * Builds a batched `MERGE INTO ... USING (VALUES ...) ...` statement that upserts every row in
 * one round-trip. Exasol has no `INSERT ... ON CONFLICT` / `ON DUPLICATE KEY UPDATE`, so an
 * upsert has to be expressed as a three-part MERGE instead: a `VALUES`-derived table supplying
 * one row per input item, an `ON` clause matching that table to the target by the conflict
 * columns, and a `WHEN MATCHED` / `WHEN NOT MATCHED` pair choosing UPDATE vs INSERT per row.
 *
 * Row values are inlined as SQL literals (via quoteLiteral(), the same helper
 * buildWhereClauseLiteral() uses for Delete) rather than bound as `?` parameters: Exasol's
 * prepared-statement support rejects a `VALUES(?, ?)` placeholder list used as a MERGE source —
 * `prepare()` fails outright — the same kind of restriction that already rules out a prepared
 * DELETE with a non-trivial WHERE (see buildWhereClauseLiteral()'s comment). The derived table's
 * correlation name is `src`, not the more obvious `source` — Exasol's grammar treats `source` as
 * reserved in this position and rejects it with a syntax error.
 *
 * @param schema - schema containing the target table
 * @param table - target table to upsert into
 * @param columns - every mapped column, in a fixed order shared by every row in `rows`
 * @param conflictColumns - subset of `columns` identifying an existing row; forms the `ON`
 *   clause. Every other column in `columns` is set on a match.
 * @param rows - one array of values per input item, in the same column order as `columns`
 * @returns the full MERGE statement text, with every row value inlined as a literal
 * @throws Error when conflictColumns is empty, contains a non-string/blank entry, names a column
 *   outside `columns`, or when any row has a NULL/undefined value for a conflict column (see
 *   assertNoNullConflictValues())
 */
export function buildMergeQuery(
	schema: string,
	table: string,
	columns: string[],
	conflictColumns: unknown[],
	rows: unknown[][],
): string {
	const updateColumns = updateColumnsFor(columns, conflictColumns);
	const matchColumns = conflictColumns as string[];
	assertNoNullConflictValues(columns, matchColumns, rows);

	const srcColumnList = columns.map(quoteIdentifier).join(', ');
	const values = rows
		.map((row) => `(${row.map(quoteLiteral).join(', ')})`)
		.join(',\n         ');

	const onClause = matchColumns
		.map((column) => `target.${quoteIdentifier(column)} = src.${quoteIdentifier(column)}`)
		.join(' AND ');

	const insertColumnList = columns.map(quoteIdentifier).join(', ');
	const insertValueList = columns.map((column) => `src.${quoteIdentifier(column)}`).join(', ');

	// A MERGE with no non-conflict columns has nothing to update on a match (every mapped column
	// is part of the conflict key) — WHEN MATCHED is omitted entirely in that case rather than
	// emitted with an empty UPDATE SET list, which Exasol would reject.
	const whenMatched =
		updateColumns.length > 0
			? `WHEN MATCHED THEN\n  UPDATE SET ${updateColumns
					.map((column) => `target.${quoteIdentifier(column)} = src.${quoteIdentifier(column)}`)
					.join(', ')}\n`
			: '';

	return (
		`MERGE INTO ${quoteIdentifier(schema)}.${quoteIdentifier(table)} target\n` +
		`USING (\n  VALUES ${values}\n) src(${srcColumnList})\n` +
		`ON ${onClause}\n` +
		whenMatched +
		`WHEN NOT MATCHED THEN\n  INSERT (${insertColumnList}) VALUES (${insertValueList})`
	);
}
