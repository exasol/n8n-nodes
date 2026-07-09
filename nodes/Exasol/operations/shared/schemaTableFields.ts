import type { INodeProperties } from 'n8n-workflow';

/**
 * Builds a "Schema Name or ID" dropdown field: `type: 'options'` with `typeOptions.loadOptionsMethod`
 * set to `listSchemas` — n8n fetches its choices at edit time by calling that method under
 * `methods.loadOptions` on the node class (see Exasol.node.ts).
 *
 * @param displayOptions - visibility condition shared with the rest of the operation's fields
 * @param verbPhrase - describes the action in the field's help text, e.g. "insert into" or
 *   "select from"
 */
export function schemaField(
	displayOptions: INodeProperties['displayOptions'],
	verbPhrase: string,
): INodeProperties {
	return {
		displayName: 'Schema Name or ID',
		name: 'schema',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'listSchemas',
		},
		default: '',
		required: true,
		description: `Schema to ${verbPhrase}. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.`,
		displayOptions,
	};
}

/**
 * Builds the "Schema Name or ID" / "Table Name or ID" field pair shared by every operation that
 * targets a single table (Select Rows, Insert, Update, Delete, Upsert): schemaField() plus a
 * matching Table field, whose `listTables` loadOptions method is re-run — clearing the current
 * selection — whenever Schema changes, via `loadOptionsDependsOn: ['schema']`.
 *
 * @param displayOptions - visibility condition shared with the rest of the operation's fields
 * @param verbPhrase - describes the action in the Schema field's help text, e.g. "insert into" or
 *   "select from"
 * @param rowsVerbPhrase - describes the action in the Table field's help text, e.g. "insert rows
 *   into" or "select rows from"
 */
export function schemaAndTableFields(
	displayOptions: INodeProperties['displayOptions'],
	verbPhrase: string,
	rowsVerbPhrase: string,
): INodeProperties[] {
	return [
		schemaField(displayOptions, verbPhrase),
		{
			displayName: 'Table Name or ID',
			name: 'table',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'listTables',
				loadOptionsDependsOn: ['schema'],
			},
			default: '',
			required: true,
			description: `Table to ${rowsVerbPhrase}. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.`,
			displayOptions,
		},
	];
}
