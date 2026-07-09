import { NodeOperationError } from 'n8n-workflow';

import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { useExasolTestFixture } from './fixtures';
import { readItemsWithAltitude, setupItemsWithAltitude } from './itemsFixture';
import { buildExecuteFunctions } from './nodeTestHelper';

describe('Delete operation', () => {
	const fixture = useExasolTestFixture({ setupData: setupItemsWithAltitude });

	const rowsInItems = () => readItemsWithAltitude(fixture);

	it('deletes a single matching row and leaves others unchanged', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'delete',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] },
			},
			items: [{ json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: { item: 0 } }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('deletes every row matching a broader WHERE condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'delete',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				where: { conditions: [{ column: 'ALTITUDE', operator: 'greaterThan', value: 1000 }] },
			},
			items: [{ json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 2 }, pairedItem: { item: 0 } }]);
		expect(await rowsInItems()).toEqual([{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 }]);
	});

	it('runs one DELETE per input item, with independent WHERE conditions', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'delete',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				where: (itemIndex: number) => ({
					conditions: [{ column: 'ID', operator: 'equals', value: itemIndex + 1 }],
				}),
			},
			items: [{ json: {} }, { json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([
			{ json: { affectedRows: 1 }, pairedItem: { item: 0 } },
			{ json: { affectedRows: 1 }, pairedItem: { item: 1 } },
		]);
		expect(await rowsInItems()).toEqual([{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 }]);
	});

	it('affects zero rows and reports affectedRows: 0 when WHERE matches nothing', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'delete',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 999 }] },
			},
			items: [{ json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 0 }, pairedItem: { item: 0 } }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens', ALTITUDE: 2300 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('throws NodeOperationError when Where has no conditions, and deletes nothing', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'delete',
			params: { schema: fixture.schema, table: 'ITEMS' },
			items: [{ json: {} }],
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Where conditions are required');
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens', ALTITUDE: 2300 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('throws NodeOperationError for an unknown table', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'delete',
			params: {
				schema: fixture.schema,
				table: 'NO_SUCH_TABLE',
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] },
			},
			items: [{ json: {} }],
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			`(query: DELETE FROM "${fixture.schema}"."NO_SUCH_TABLE"`,
		);
	});
});
