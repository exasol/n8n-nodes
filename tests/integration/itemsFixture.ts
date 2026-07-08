import type { ExasolDriver } from '@exasol/exasol-driver-ts';

import type { ExasolTestFixture } from './fixtures';

/** A row of the ITEMS(ID, NAME, ALTITUDE) table seeded by setupItemsWithAltitude(). */
export interface ItemWithAltitude {
	ID: number;
	NAME: string | null;
	ALTITUDE: number | null;
}

/**
 * Seeds the ITEMS(ID, NAME, ALTITUDE) table shared by the Update and Delete integration
 * suites: three ski resorts. Matches setupData's (driver, schema) signature so it can be
 * passed straight to useExasolTestFixture().
 */
export async function setupItemsWithAltitude(driver: ExasolDriver, schema: string): Promise<void> {
	await driver.execute(
		`CREATE TABLE ${schema}.ITEMS (ID INTEGER, NAME VARCHAR(100), ALTITUDE INTEGER)`,
	);
	await driver.execute(`
		INSERT INTO ${schema}.ITEMS VALUES
			(1, 'Val Thorens', 2300),
			(2, 'Courchevel', 1850),
			(3, 'Kitzbuhel', 762)
	`);
}

/**
 * Reads back the ITEMS table's current contents, ordered by ID.
 *
 * ID/ALTITUDE come back over the wire as either a number or a numeric string depending on the
 * driver's decoding of INTEGER — coerced here with Number() so assertions don't depend on
 * which representation the driver happens to choose.
 *
 * @returns every row currently in the fixture's ITEMS table
 */
export async function readItemsWithAltitude(fixture: ExasolTestFixture): Promise<ItemWithAltitude[]> {
	const result = await fixture.connection.query(
		`SELECT ID, NAME, ALTITUDE FROM ${fixture.schema}.ITEMS ORDER BY ID`,
	);
	return result.getRows().map((row) => ({
		ID: Number(row.ID),
		NAME: row.NAME as string | null,
		ALTITUDE: row.ALTITUDE === null ? null : Number(row.ALTITUDE),
	}));
}
