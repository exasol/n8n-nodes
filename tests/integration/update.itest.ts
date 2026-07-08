import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { useExasolTestFixture } from './fixtures';
import { buildExecuteFunctions } from './nodeTestHelper';

describe('Update operation', () => {
	const fixture = useExasolTestFixture({
		setupData: async (driver: ExasolDriver, schema: string) => {
			await driver.execute(`CREATE TABLE ${schema}.ITEMS (ID INTEGER, NAME VARCHAR(100), ALTITUDE INTEGER)`);
			await driver.execute(`
				INSERT INTO ${schema}.ITEMS VALUES
					(1, 'Val Thorens', 2300),
					(2, 'Courchevel', 1850),
					(3, 'Kitzbuhel', 762)
			`);
		},
	});

	/**
	 * Reads back the ITEMS table's current contents, ordered by ID.
	 *
	 * ID/ALTITUDE come back over the wire as either a number or a numeric string depending on the
	 * driver's decoding of INTEGER — coerced here with Number() so assertions don't depend on
	 * which representation the driver happens to choose (same pattern as insert.itest.ts).
	 *
	 * @returns every row currently in the fixture's ITEMS table
	 */
	async function rowsInItems(): Promise<
		Array<{ ID: number; NAME: string | null; ALTITUDE: number | null }>
	> {
		const result = await fixture.connection.query(
			`SELECT ID, NAME, ALTITUDE FROM ${fixture.schema}.ITEMS ORDER BY ID`,
		);
		return result.getRows().map((row) => ({
			ID: Number(row.ID),
			NAME: row.NAME as string | null,
			ALTITUDE: row.ALTITUDE === null ? null : Number(row.ALTITUDE),
		}));
	}

	it('updates a single matching row via Auto-Map Input Data and leaves others unchanged', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'update',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] },
			},
			items: [{ json: { NAME: 'Val Thorens (updated)' } }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: { item: 0 } }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens (updated)', ALTITUDE: 2300 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('updates every row matching a broader WHERE condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'update',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				dataMode: 'defineBelow',
				columns: { mappings: [{ column: 'ALTITUDE', value: 0 }] },
				where: { conditions: [{ column: 'ALTITUDE', operator: 'greaterThan', value: 1000 }] },
			},
			items: [{ json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 2 }, pairedItem: { item: 0 } }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens', ALTITUDE: 0 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 0 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('updates rows using Map Each Column Below (defineBelow)', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'update',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				dataMode: 'defineBelow',
				columns: { mappings: [{ column: 'NAME', value: 'Kitzbuhel (updated)' }] },
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 3 }] },
			},
			items: [{ json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: { item: 0 } }]);
		expect(await rowsInItems()).toContainEqual({
			ID: 3,
			NAME: 'Kitzbuhel (updated)',
			ALTITUDE: 762,
		});
	});

	it('affects zero rows and reports affectedRows: 0 when WHERE matches nothing', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'update',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 999 }] },
			},
			items: [{ json: { NAME: 'nobody' } }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 0 }, pairedItem: { item: 0 } }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens', ALTITUDE: 2300 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('throws NodeOperationError when Where has no conditions, and writes nothing', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'update',
			params: { schema: fixture.schema, table: 'ITEMS' },
			items: [{ json: { NAME: 'should not land' } }],
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
			operation: 'update',
			params: {
				schema: fixture.schema,
				table: 'NO_SUCH_TABLE',
				where: { conditions: [{ column: 'ID', operator: 'equals', value: 1 }] },
			},
			items: [{ json: { NAME: 'x' } }],
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			`(query: UPDATE "${fixture.schema}"."NO_SUCH_TABLE"`,
		);
	});
});
