import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	buildRow,
	findUnknownColumns,
	readColumnMappings,
	readColumns,
} from '../../nodes/Exasol/operations/shared/columnMappings';

describe('readColumnMappings()', () => {
	type ColumnMappings = { mappings?: Array<{ column: unknown; value?: unknown }> };

	function makeContext(columns?: ColumnMappings): IExecuteFunctions {
		return {
			getNodeParameter: jest
				.fn()
				.mockImplementation((name: string, _itemIndex?: number, fallback?: unknown) => {
					if (name === 'columns') return columns ?? fallback ?? {};
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	it('returns an empty array when the Columns collection has no mappings', () => {
		expect(readColumnMappings(makeContext({}), 0)).toEqual([]);
	});

	it('returns the configured mappings', () => {
		const mappings = [{ column: 'ID', value: 1 }];
		expect(readColumnMappings(makeContext({ mappings }), 0)).toEqual(mappings);
	});
});

describe('readColumns()', () => {
	type ColumnMappings = { mappings?: Array<{ column: unknown; value?: unknown }> };

	function makeContext(columns?: ColumnMappings): IExecuteFunctions {
		return {
			getNodeParameter: jest
				.fn()
				.mockImplementation((name: string, _itemIndex?: number, fallback?: unknown) => {
					if (name === 'columns') return columns ?? fallback ?? {};
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	// ── autoMapInputData ────────────────────────────────────────────────────────

	it('returns the first item JSON keys for autoMapInputData', () => {
		const firstItem: INodeExecutionData = { json: { ID: 1, NAME: 'a' } };
		expect(readColumns(makeContext(), 'autoMapInputData', firstItem)).toEqual(['ID', 'NAME']);
	});

	it('returns an empty array when the first item has no JSON keys (autoMapInputData)', () => {
		expect(readColumns(makeContext(), 'autoMapInputData', { json: {} })).toEqual([]);
	});

	// ── defineBelow ─────────────────────────────────────────────────────────────

	it('returns column names from the Columns collection for defineBelow', () => {
		const ctx = makeContext({ mappings: [{ column: 'ID' }, { column: 'NAME' }] });
		expect(readColumns(ctx, 'defineBelow', { json: {} })).toEqual(['ID', 'NAME']);
	});

	it('returns an empty array when the Columns collection is empty (defineBelow)', () => {
		expect(readColumns(makeContext({}), 'defineBelow', { json: {} })).toEqual([]);
	});

	it('throws NodeOperationError for an empty column name (defineBelow)', () => {
		const ctx = makeContext({ mappings: [{ column: '' }] });

		expect(() => readColumns(ctx, 'defineBelow', { json: {} })).toThrow(NodeOperationError);
		expect(() => readColumns(ctx, 'defineBelow', { json: {} })).toThrow(
			'Column name must be a non-empty string.',
		);
	});

	it('throws NodeOperationError for an undefined column name (defineBelow)', () => {
		const ctx = makeContext({ mappings: [{ column: undefined }] });

		expect(() => readColumns(ctx, 'defineBelow', { json: {} })).toThrow(
			'Column name must be a non-empty string.',
		);
	});

	it('throws NodeOperationError for a numeric column name (defineBelow)', () => {
		const ctx = makeContext({ mappings: [{ column: 42 }] });

		expect(() => readColumns(ctx, 'defineBelow', { json: {} })).toThrow(
			'Column name must be a non-empty string.',
		);
	});

	it('attributes the thrown error to itemIndex 0 regardless of the caller', () => {
		const ctx = makeContext({ mappings: [{ column: '' }] });

		try {
			readColumns(ctx, 'defineBelow', { json: {} });
			throw new Error('expected readColumns to throw');
		} catch (error) {
			expect((error as NodeOperationError).context).toMatchObject({ itemIndex: 0 });
		}
	});
});

describe('buildRow()', () => {
	type ColumnMappings = { mappings?: Array<{ column: unknown; value?: unknown }> };

	function makeContext(
		columns?: ColumnMappings | ((itemIndex: number) => ColumnMappings),
	): IExecuteFunctions {
		return {
			getNodeParameter: jest
				.fn()
				.mockImplementation((name: string, itemIndex?: number, fallback?: unknown) => {
					if (name === 'columns') {
						if (typeof columns === 'function') return columns(itemIndex ?? 0);
						return columns ?? fallback ?? {};
					}
					throw new Error(`Unexpected parameter name in mock: ${name}`);
				}),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	// ── autoMapInputData ────────────────────────────────────────────────────────

	it('builds a row from the item JSON in column order (autoMapInputData)', () => {
		const item: INodeExecutionData = { json: { ID: 1, NAME: 'a' } };
		expect(buildRow(makeContext(), 'autoMapInputData', ['ID', 'NAME'], item, 0)).toEqual([1, 'a']);
	});

	it('uses null for a column missing from the item JSON (autoMapInputData)', () => {
		const item: INodeExecutionData = { json: { ID: 1 } };
		expect(buildRow(makeContext(), 'autoMapInputData', ['ID', 'NAME'], item, 0)).toEqual([1, null]);
	});

	// ── defineBelow ─────────────────────────────────────────────────────────────

	it('builds a row from the Columns collection in column order (defineBelow)', () => {
		const ctx = makeContext({
			mappings: [
				{ column: 'NAME', value: 'a' },
				{ column: 'ID', value: 1 },
			],
		});
		expect(buildRow(ctx, 'defineBelow', ['ID', 'NAME'], { json: {} }, 0)).toEqual([1, 'a']);
	});

	it('uses null for a mapping row with no Value set (defineBelow)', () => {
		const ctx = makeContext({ mappings: [{ column: 'ID' }] });
		expect(buildRow(ctx, 'defineBelow', ['ID'], { json: {} }, 0)).toEqual([null]);
	});

	it('uses null for a column with no matching mapping row (defineBelow)', () => {
		const ctx = makeContext({ mappings: [{ column: 'ID', value: 1 }] });
		expect(buildRow(ctx, 'defineBelow', ['ID', 'NAME'], { json: {} }, 0)).toEqual([1, null]);
	});

	it('re-reads the Columns collection per item (defineBelow)', () => {
		const mappingsByItem: ColumnMappings[] = [
			{ mappings: [{ column: 'ID', value: 1 }] },
			{ mappings: [{ column: 'ID', value: 2 }] },
		];
		const ctx = makeContext((itemIndex) => mappingsByItem[itemIndex]);

		expect(buildRow(ctx, 'defineBelow', ['ID'], { json: {} }, 0)).toEqual([1]);
		expect(buildRow(ctx, 'defineBelow', ['ID'], { json: {} }, 1)).toEqual([2]);
	});

	it('throws NodeOperationError when a mapping names a column outside the given column list', () => {
		const ctx = makeContext({
			mappings: [
				{ column: 'ID', value: 1 },
				{ column: 'NAAME', value: 'typo' },
			],
		});

		expect(() => buildRow(ctx, 'defineBelow', ['ID', 'NAME'], { json: {} }, 3)).toThrow(
			NodeOperationError,
		);
		expect(() => buildRow(ctx, 'defineBelow', ['ID', 'NAME'], { json: {} }, 3)).toThrow(
			/Item 3 maps column\(s\).*NAAME/,
		);
	});

	it('attributes the unknown-column error to the given itemIndex', () => {
		const ctx = makeContext({ mappings: [{ column: 'NOPE', value: 1 }] });

		try {
			buildRow(ctx, 'defineBelow', ['ID'], { json: {} }, 2);
			throw new Error('expected buildRow to throw');
		} catch (error) {
			expect((error as NodeOperationError).context).toMatchObject({ itemIndex: 2 });
		}
	});
});

describe('findUnknownColumns()', () => {
	it('returns an empty array when every candidate is known', () => {
		expect(findUnknownColumns(['ID', 'NAME'], ['ID', 'NAME', 'ALTITUDE'])).toEqual([]);
	});

	it('returns the candidates absent from knownColumns, preserving order', () => {
		expect(findUnknownColumns(['ID', 'NOPE', 'NAME', 'ALSO_NOPE'], ['ID', 'NAME'])).toEqual([
			'NOPE',
			'ALSO_NOPE',
		]);
	});

	it('returns every candidate when knownColumns is empty', () => {
		expect(findUnknownColumns(['ID', 'NAME'], [])).toEqual(['ID', 'NAME']);
	});

	it('returns an empty array when candidates is empty', () => {
		expect(findUnknownColumns([], ['ID'])).toEqual([]);
	});
});
