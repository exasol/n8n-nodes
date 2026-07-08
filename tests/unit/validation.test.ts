import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { requireNonEmpty } from '../../nodes/Exasol/operations/shared/validation';

describe('requireNonEmpty()', () => {
	function makeContext(): IExecuteFunctions {
		return {
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	it('returns the value unchanged when it has no surrounding whitespace', () => {
		expect(requireNonEmpty(makeContext(), 'MY_SCHEMA', 'Schema', 0)).toBe('MY_SCHEMA');
	});

	it('trims surrounding whitespace before returning', () => {
		expect(requireNonEmpty(makeContext(), '  MY_TABLE  ', 'Table', 0)).toBe('MY_TABLE');
	});

	it('throws NodeOperationError with the field label for an empty value', () => {
		const ctx = makeContext();

		expect(() => requireNonEmpty(ctx, '', 'Schema', 2)).toThrow(NodeOperationError);
		expect(() => requireNonEmpty(ctx, '', 'Schema', 2)).toThrow('Schema must not be empty');
	});

	it('throws NodeOperationError for a whitespace-only value', () => {
		expect(() => requireNonEmpty(makeContext(), '   ', 'Table', 0)).toThrow(
			'Table must not be empty',
		);
	});

	// An expression-driven Schema/Table field (e.g. ={{ $json.schemaId }}) can resolve to a
	// non-string at runtime even though the UI type says string; this must fail the same
	// friendly way as an empty string, not throw a raw TypeError out of .trim().
	it('throws NodeOperationError for a non-string value instead of throwing a raw TypeError', () => {
		expect(() => requireNonEmpty(makeContext(), 42, 'Schema', 0)).toThrow(
			'Schema must not be empty',
		);
	});

	it('attributes the thrown error to the given itemIndex', () => {
		try {
			requireNonEmpty(makeContext(), '', 'Schema', 3);
			throw new Error('expected requireNonEmpty to throw');
		} catch (error) {
			expect((error as NodeOperationError).context).toMatchObject({ itemIndex: 3 });
		}
	});
});
