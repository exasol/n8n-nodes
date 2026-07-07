import { resultSetToRows } from '../../nodes/Exasol/operations/shared/resultMapper';
import type { ResultSet } from '@exasol/exasol-driver-ts';

// Builds a ResultSet in the driver's column-major wire format (data[colIdx][rowIdx]) from a
// friendlier row-major input, so tests stay readable.
function resultSet(rows: Record<string, unknown>[]): ResultSet {
	const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
	return {
		numColumns: columnNames.length,
		numRows: rows.length,
		numRowsInMessage: rows.length,
		columns: columnNames.map((name) => ({ name, dataType: { type: 'VARCHAR' } })),
		data: columnNames.map((col) => rows.map((row) => row[col] ?? null)),
	} as unknown as ResultSet;
}

describe('resultSetToRows()', () => {
	it('pivots a single-row, single-column result set to a row object', () => {
		expect(resultSetToRows(resultSet([{ ID: 1 }]))).toEqual([{ ID: 1 }]);
	});

	it('pivots multiple rows, preserving order', () => {
		expect(resultSetToRows(resultSet([{ ID: 1 }, { ID: 2 }, { ID: 3 }]))).toEqual([
			{ ID: 1 },
			{ ID: 2 },
			{ ID: 3 },
		]);
	});

	it('pivots multiple columns into one row object per row', () => {
		const rows = resultSetToRows(
			resultSet([
				{ A: 1, B: 'x' },
				{ A: 2, B: 'y' },
			]),
		);

		expect(rows).toEqual([
			{ A: 1, B: 'x' },
			{ A: 2, B: 'y' },
		]);
	});

	it('returns an empty array when numRows is 0', () => {
		expect(resultSetToRows(resultSet([]))).toEqual([]);
	});

	it('returns an empty array when data is missing (defensive)', () => {
		const rs = {
			numColumns: 1,
			numRows: 2,
			numRowsInMessage: 2,
			columns: [{ name: 'ID' }],
		} as unknown as ResultSet;

		expect(resultSetToRows(rs)).toEqual([]);
	});

	it('converts a null cell to null rather than undefined', () => {
		expect(resultSetToRows(resultSet([{ ID: 1, NOTES: null }]))).toEqual([{ ID: 1, NOTES: null }]);
	});

	it('keys each row by column name', () => {
		const [row] = resultSetToRows(resultSet([{ FIRST_NAME: 'Ada', AGE: 36 }]));

		expect(Object.keys(row)).toEqual(['FIRST_NAME', 'AGE']);
	});
});
