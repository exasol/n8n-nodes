import { schemaAndTableFields } from '../../nodes/Exasol/operations/shared/schemaTableFields';

describe('schemaAndTableFields()', () => {
	const displayOptions = { show: { operation: ['insert'] } };

	it('returns exactly a schema and a table field, in that order', () => {
		const fields = schemaAndTableFields(displayOptions, 'insert into', 'insert rows into');

		expect(fields).toHaveLength(2);
		expect(fields[0].name).toBe('schema');
		expect(fields[1].name).toBe('table');
	});

	it('applies the given displayOptions to both fields', () => {
		const fields = schemaAndTableFields(displayOptions, 'insert into', 'insert rows into');

		expect(fields[0].displayOptions).toBe(displayOptions);
		expect(fields[1].displayOptions).toBe(displayOptions);
	});

	it('wires Table to depend on Schema via loadOptionsDependsOn', () => {
		const [, table] = schemaAndTableFields(displayOptions, 'insert into', 'insert rows into');

		expect(table.typeOptions).toMatchObject({
			loadOptionsMethod: 'listTables',
			loadOptionsDependsOn: ['schema'],
		});
	});

	it('interpolates the given verb phrases into the field descriptions', () => {
		const [schema, table] = schemaAndTableFields(displayOptions, 'select from', 'select rows from');

		expect(schema.description).toContain('Schema containing the table to select from.');
		expect(table.description).toContain('Table to select rows from.');
	});
});
