import { NodeOperationError } from 'n8n-workflow';

import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { useExasolTestFixture } from './fixtures';
import { buildExecuteFunctions } from './nodeTestHelper';

describe('Upsert operation', () => {
	const fixture = useExasolTestFixture({
		setupData: async (driver: ExasolDriver, schema: string) => {
			await driver.execute(
				`CREATE TABLE ${schema}.ITEMS (ID INTEGER, NAME VARCHAR(100), ALTITUDE INTEGER)`,
			);
			await driver.execute(
				`INSERT INTO ${schema}.ITEMS VALUES (1, 'Val Thorens', 2300), (2, 'Courchevel', 1850)`,
			);
		},
	});

	// ID/ALTITUDE come back over the wire as either a number or a numeric string depending on the
	// driver's decoding of INTEGER — coerced here with Number() so assertions don't depend on
	// which representation the driver happens to choose (same pattern as update.itest.ts).
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

	it('inserts a new row that has no matching ID (NOT MATCHED)', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: { schema: fixture.schema, table: 'ITEMS', conflictColumns: ['ID'] },
			items: [{ json: { ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 } }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens', ALTITUDE: 2300 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('updates an existing row that matches the conflict column (MATCHED)', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: { schema: fixture.schema, table: 'ITEMS', conflictColumns: ['ID'] },
			items: [{ json: { ID: 1, NAME: 'Val Thorens (updated)', ALTITUDE: 2301 } }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens (updated)', ALTITUDE: 2301 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
		]);
	});

	it('handles a mixed batch of matched and unmatched rows in one round-trip', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: { schema: fixture.schema, table: 'ITEMS', conflictColumns: ['ID'] },
			items: [
				{ json: { ID: 1, NAME: 'Val Thorens (updated)', ALTITUDE: 2301 } },
				{ json: { ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 } },
			],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([
			{ json: { affectedRows: 2 }, pairedItem: [{ item: 0 }, { item: 1 }] },
		]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens (updated)', ALTITUDE: 2301 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
			{ ID: 3, NAME: 'Kitzbuhel', ALTITUDE: 762 },
		]);
	});

	it('upserts rows using Map Each Column Below (defineBelow)', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: {
				schema: fixture.schema,
				table: 'ITEMS',
				dataMode: 'defineBelow',
				columns: {
					mappings: [
						{ column: 'ID', value: 4 },
						{ column: 'NAME', value: 'Zermatt' },
						{ column: 'ALTITUDE', value: 1620 },
					],
				},
				conflictColumns: ['ID'],
			},
			items: [{ json: {} }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
		expect(await rowsInItems()).toContainEqual({ ID: 4, NAME: 'Zermatt', ALTITUDE: 1620 });
	});

	it('matches on multiple conflict columns together', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: { schema: fixture.schema, table: 'ITEMS', conflictColumns: ['ID', 'NAME'] },
			items: [
				// Matches ID=1 but not NAME — treated as NOT MATCHED and inserted as a new row.
				{ json: { ID: 1, NAME: 'Val Thorens (renamed)', ALTITUDE: 9999 } },
			],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens', ALTITUDE: 2300 },
			{ ID: 1, NAME: 'Val Thorens (renamed)', ALTITUDE: 9999 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
		]);
	});

	// Exasol's MERGE ON clause only permits a plain "=" (Exasol's own docs: "In the ON condition,
	// only equivalence conditions (=) are permitted"), which rules out a NULL-safe ON clause at
	// the SQL level — confirmed against this instance: an OR/IS NULL-based ON clause is rejected
	// outright with "such a merge condition is not supported!". A row with a NULL conflict-column
	// value is therefore rejected before ever reaching the database, rather than silently
	// inserting a duplicate on every repeated upsert (NULL = NULL is UNKNOWN, not TRUE, in SQL).
	it('rejects a row with a NULL conflict-column value, and writes nothing', async () => {
		await fixture.connection.execute(
			`CREATE TABLE ${fixture.schema}.NULLABLE_KEY (ID INTEGER, REGION VARCHAR(20), NAME VARCHAR(100))`,
		);
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: {
				schema: fixture.schema,
				table: 'NULLABLE_KEY',
				conflictColumns: ['ID', 'REGION'],
			},
			items: [{ json: { ID: 1, REGION: null, NAME: 'first' } }],
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			'Row 0 has no value for Conflict Column "REGION"',
		);
		const rows = await fixture.connection.query(
			`SELECT ID, REGION, NAME FROM ${fixture.schema}.NULLABLE_KEY ORDER BY ID`,
		);
		expect(rows.getRows()).toEqual([]);
	});

	// quoteLiteral()'s generic stringify fallback would render a JS Date via its verbose
	// locale-formatted toString(), which Exasol can't parse as a TIMESTAMP — must go through the
	// dedicated Date branch instead (see whereBuilder.test.ts's quoteLiteral() suite).
	it('upserts a Date value as a valid TIMESTAMP literal', async () => {
		await fixture.connection.execute(
			`CREATE TABLE ${fixture.schema}.EVENTS (ID INTEGER, HAPPENED_AT TIMESTAMP)`,
		);
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: { schema: fixture.schema, table: 'EVENTS', conflictColumns: ['ID'] },
			items: [{ json: { ID: 1, HAPPENED_AT: new Date('2024-01-15T10:30:00.123Z') } }],
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([{ json: { affectedRows: 1 }, pairedItem: [{ item: 0 }] }]);
		const rows = await fixture.connection.query(
			`SELECT ID, HAPPENED_AT FROM ${fixture.schema}.EVENTS ORDER BY ID`,
		);
		expect(rows.getRows()).toEqual([
			// Exasol reads TIMESTAMP back with 6 fractional digits regardless of the literal's
			// precision (3 in this case) — the leading "123" (milliseconds) round-tripped correctly.
			{ ID: expect.anything(), HAPPENED_AT: '2024-01-15 10:30:00.123000' },
		]);
	});

	it('throws NodeOperationError when Conflict Columns is empty, and writes nothing', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: { schema: fixture.schema, table: 'ITEMS', conflictColumns: [] },
			items: [{ json: { ID: 5, NAME: 'should not land', ALTITUDE: 0 } }],
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('At least one Conflict Column is required');
		expect(await rowsInItems()).toEqual([
			{ ID: 1, NAME: 'Val Thorens', ALTITUDE: 2300 },
			{ ID: 2, NAME: 'Courchevel', ALTITUDE: 1850 },
		]);
	});

	it('throws NodeOperationError for an unknown table', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'upsert',
			params: { schema: fixture.schema, table: 'NO_SUCH_TABLE', conflictColumns: ['ID'] },
			items: [{ json: { ID: 1, NAME: 'x', ALTITUDE: 0 } }],
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain(
			`(query: MERGE INTO "${fixture.schema}"."NO_SUCH_TABLE"`,
		);
	});
});
