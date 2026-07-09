import {
	schemaField,
	schemaAndTableFields,
} from '../../nodes/Exasol/operations/shared/schemaTableFields';

describe('schemaField()', () => {
	const displayOptions = { show: { operation: ['listTables'] } };

	it('returns a single "schema" field', () => {
		const field = schemaField(displayOptions, 'list tables from');

		expect(field.name).toBe('schema');
		expect(field.type).toBe('options');
	});

	it('wires up the listSchemas loadOptions method', () => {
		const field = schemaField(displayOptions, 'list tables from');

		expect(field.typeOptions).toMatchObject({ loadOptionsMethod: 'listSchemas' });
	});

	it('applies the given displayOptions', () => {
		const field = schemaField(displayOptions, 'list tables from');

		expect(field.displayOptions).toBe(displayOptions);
	});

	it('interpolates the given verb phrase into the description', () => {
		const field = schemaField(displayOptions, 'list tables from');

		expect(field.description).toContain('Schema to list tables from.');
	});
});

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

		expect(schema.description).toContain('Schema to select from.');
		expect(table.description).toContain('Table to select rows from.');
	});

	it('builds its Schema field the same way schemaField() does', () => {
		const [schema] = schemaAndTableFields(displayOptions, 'insert into', 'insert rows into');

		expect(schema).toEqual(schemaField(displayOptions, 'insert into'));
	});
});
