import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { useExasolTestFixture } from './fixtures';
import { buildExecuteFunctions } from './nodeTestHelper';
import { setupTestData } from './testData';

describe('Schema Explorer operations', () => {
	const fixture = useExasolTestFixture({ setupData: setupTestData });

	// setupTestData (tests/integration/testData.ts) seeds each fresh schema with:
	//   - SKI_RESORT: PK (RESORT_ID); columns RESORT_ID, RESORT_NAME, COUNTRY, ALTITUDE
	//   - SKI_RUN: composite PK (RESORT_ID, RUN_NAME); FK RESORT_FK -> SKI_RESORT(RESORT_ID)
	//   - COMPETITIONS: composite FK COMPETITION_FK -> SKI_RUN(RESORT_ID, RUN_NAME)
	//   - Views: HIGH_ALTITUDE_RESORT (on SKI_RESORT), DIFFICULT_RUN (on SKI_RUN)

	describe('List Schemas', () => {
		it('includes the freshly created test schema, with its comment', async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'listSchemas',
			});
			const [result] = await new Exasol().execute.call(ctx);

			const testSchema = result.find((item) => item.json.name === fixture.schema);
			expect(testSchema).toBeDefined();
		});
	});

	describe('List Tables', () => {
		it('lists only tables when Include Views is false', async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'listTables',
				params: { schema: fixture.schema, includeViews: false },
			});
			const [result] = await new Exasol().execute.call(ctx);

			expect(result.map((item) => item.json.name).sort()).toEqual([
				'COMPETITIONS',
				'SKI_RESORT',
				'SKI_RUN',
			]);
			result.forEach((item) => expect(item.json.type).toBe('TABLE'));
		});

		it('includes views alongside tables when Include Views is true', async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'listTables',
				params: { schema: fixture.schema, includeViews: true },
			});
			const [result] = await new Exasol().execute.call(ctx);

			expect(result.map((item) => item.json.name).sort()).toEqual([
				'COMPETITIONS',
				'DIFFICULT_RUN',
				'HIGH_ALTITUDE_RESORT',
				'SKI_RESORT',
				'SKI_RUN',
			]);
			const view = result.find((item) => item.json.name === 'HIGH_ALTITUDE_RESORT');
			expect(view?.json.type).toBe('VIEW');
			expect(view?.json.comment).toBe('ski resorts situated at the altitude higher than 2000 meters');
		});

		it('reports the table comment set via COMMENT ON TABLE', async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'listTables',
				params: { schema: fixture.schema },
			});
			const [result] = await new Exasol().execute.call(ctx);

			const skiResort = result.find((item) => item.json.name === 'SKI_RESORT');
			expect(skiResort?.json.comment).toBe('the table contains basic information about ski resorts');
		});
	});

	describe('Describe Table', () => {
		it("describes SKI_RESORT's columns and single-column PRIMARY KEY", async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'describeTable',
				params: { schema: fixture.schema, table: 'SKI_RESORT' },
			});
			const [result] = await new Exasol().execute.call(ctx);

			const columns = result.slice(0, -1);
			const summary = result[result.length - 1];

			expect(columns.map((item) => item.json.name)).toEqual([
				'RESORT_ID',
				'RESORT_NAME',
				'COUNTRY',
				'ALTITUDE',
			]);
			const resortId = columns.find((item) => item.json.name === 'RESORT_ID');
			expect(resortId?.json.comment).toBe('the ski resort id');
			expect(resortId?.json.type).toContain('DECIMAL');
			const resortName = columns.find((item) => item.json.name === 'RESORT_NAME');
			expect(resortName?.json.comment).toBeNull();
			expect(resortName?.json.type).toContain('VARCHAR');

			expect(summary.json.constraints).toEqual([
				expect.objectContaining({
					type: 'PRIMARY KEY',
					columns: ['RESORT_ID'],
				}),
			]);
		});

		it('describes SKI_RUN\'s composite PRIMARY KEY and FOREIGN KEY to SKI_RESORT', async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'describeTable',
				params: { schema: fixture.schema, table: 'SKI_RUN' },
			});
			const [result] = await new Exasol().execute.call(ctx);

			const summary = result[result.length - 1];
			const constraints = summary.json.constraints as Array<Record<string, unknown>>;

			const primaryKey = constraints.find((c) => c.type === 'PRIMARY KEY');
			expect(primaryKey?.columns).toEqual(['RESORT_ID', 'RUN_NAME']);

			const foreignKey = constraints.find((c) => c.type === 'FOREIGN KEY');
			expect(foreignKey).toMatchObject({
				columns: ['RESORT_ID'],
				referencedSchema: fixture.schema,
				referencedTable: 'SKI_RESORT',
				referencedColumns: ['RESORT_ID'],
			});
		});

		it("describes COMPETITIONS' composite FOREIGN KEY to SKI_RUN, pairing columns positionally", async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'describeTable',
				params: { schema: fixture.schema, table: 'COMPETITIONS' },
			});
			const [result] = await new Exasol().execute.call(ctx);

			const summary = result[result.length - 1];
			const constraints = summary.json.constraints as Array<Record<string, unknown>>;

			expect(constraints).toEqual([
				expect.objectContaining({
					type: 'FOREIGN KEY',
					columns: ['RESORT_ID', 'COMPETITION_RUN'],
					referencedSchema: fixture.schema,
					referencedTable: 'SKI_RUN',
					referencedColumns: ['RESORT_ID', 'RUN_NAME'],
				}),
			]);
		});

		it('describes a view, returning its columns with an empty constraints list', async () => {
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'describeTable',
				params: { schema: fixture.schema, table: 'HIGH_ALTITUDE_RESORT' },
			});
			const [result] = await new Exasol().execute.call(ctx);

			const columns = result.slice(0, -1);
			const summary = result[result.length - 1];

			expect(columns.map((item) => item.json.name)).toEqual([
				'RESORT_ID',
				'RESORT_NAME',
				'COUNTRY',
				'ALTITUDE',
			]);
			expect(summary.json).toEqual({ constraints: [] });
		});

		it('returns an empty column list and an empty constraints summary for an unknown table', async () => {
			// Unlike Select Rows' SELECT * FROM <unknown table>, which fails at the SQL level,
			// EXA_ALL_COLUMNS/EXA_ALL_CONSTRAINT_COLUMNS simply return zero rows for an unknown
			// table/schema pair — there is no driver-level error to surface here.
			const ctx = buildExecuteFunctions({
				container: fixture.container,
				operation: 'describeTable',
				params: { schema: fixture.schema, table: 'NO_SUCH_TABLE' },
			});

			const [result] = await new Exasol().execute.call(ctx);

			expect(result).toEqual([{ json: { constraints: [] }, pairedItem: { item: 0 } }]);
		});
	});
});
