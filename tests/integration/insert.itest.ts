import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { useExasolTestFixture } from './fixtures';
import { buildExecuteFunctions } from './nodeTestHelper';

describe('Insert operation', () => {
	const fixture = useExasolTestFixture({
		setupData: async (driver: ExasolDriver, schema: string) => {
			await driver.execute(`CREATE TABLE ${schema}.ITEMS (ID INTEGER, NAME VARCHAR(100))`);
		},
	});

	// ID comes back over the wire as either a number or a numeric string depending on the
	// driver's decoding of INTEGER — coerced here with Number() so assertions don't depend on
	// which representation the driver happens to choose (same pattern as selectRows.itest.ts).
	async function rowsInItems(): Promise<Array<{ ID: number; NAME: string | null }>> {
		const result = await fixture.connection.query(
			`SELECT ID, NAME FROM ${fixture.schema}.ITEMS ORDER BY ID`,
		);
		return result.getRows().map((row) => ({ ID: Number(row.ID), NAME: row.NAME as string | null }));
	}

	it('inserts a single row via Auto-Map Input Data and verifies it landed', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'insert',
			params: { schema: fixture.schema, table: 'ITEMS' },
			items: [{ json: { ID: 1, NAME: 'Val Thorens' } }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
		expect(await rowsInItems()).toEqual([{ ID: 1, NAME: 'Val Thorens' }]);
	});

	it('inserts 5 rows in one batch and verifies affectedRows and row count', async () => {
		const items = Array.from({ length: 5 }, (_, i) => ({
			json: { ID: i + 1, NAME: `Resort ${i + 1}` },
		}));
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'insert',
			params: { schema: fixture.schema, table: 'ITEMS' },
			items,
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([
			{ json: { affectedRows: 5 }, pairedItem: [0, 1, 2, 3, 4].map((item) => ({ item })) },
		]);
		expect(await rowsInItems()).toHaveLength(5);
	});

	it('inserts rows using Map Each Column Below (defineBelow)', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'insert',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				dataMode: 'defineBelow',
				columns: { mappings: [{ column: 'ID', value: 7 }, { column: 'NAME', value: 'Kitzbuhel' }] },
			},
			items: [{ json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
		expect(await rowsInItems()).toEqual([{ ID: 7, NAME: 'Kitzbuhel' }]);
	});

	it('throws NodeOperationError for an unknown table', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'insert',
			params: { schema: fixture.schema, table: 'NO_SUCH_TABLE' },
			items: [{ json: { ID: 1, NAME: 'x' } }],
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		// The driver's prepare() unconditionally reads response.responseData.statementHandle
		// (see the identical caveat in selectRows/execute.ts's runSelect() about .columns), so a
		// failed createPreparedStatement — e.g. for a nonexistent table — surfaces as a generic
		// "Cannot read properties of undefined" TypeError rather than Exasol's own SQL exception
		// text. What we can still assert: it's a NodeOperationError, attributed with the SQL that
		// caused it, and nothing was written to the table.
		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			`(query: INSERT INTO "${fixture.schema}"."NO_SUCH_TABLE"`,
		);
		expect(await rowsInItems()).toEqual([]);
	});
});
