import type { ResultSet } from '@exasol/exasol-driver-ts';

/** A single Exasol cell value as returned over the WebSocket protocol. */
export type ExasolColumnValue = string | number | boolean | null;

/**
 * Converts the columnar ResultSet wire format from the Exasol WebSocket protocol into an array
 * of row objects keyed by column name. The driver stores result data as
 * data[columnIndex][rowIndex] (column-major); this pivots it to the row-major shape n8n expects.
 *
 * Shared by every operation that can return a SELECT-style result set (Execute Query, Select
 * Rows, and any future read operation) — kept separate from the DML rowCount handling that only
 * Execute Query needs, since that branching differs per operation.
 */
export function resultSetToRows(resultSet: ResultSet): Array<Record<string, ExasolColumnValue>> {
	const { columns, data, numRows } = resultSet;
	if (!data || numRows === 0) return [];
	return Array.from({ length: numRows }, (_, rowIdx) => {
		const row: Record<string, ExasolColumnValue> = {};
		columns.forEach((col, colIdx) => {
			row[col.name] = data[colIdx]?.[rowIdx] ?? null;
		});
		return row;
	});
}
