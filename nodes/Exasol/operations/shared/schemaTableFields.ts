import type { INodeProperties } from 'n8n-workflow';

/**
 * Builds the "Schema Name or ID" / "Table Name or ID" field pair shared by every operation that
 * targets a single table (Select Rows, Insert, and — in later PRs — Update, Delete, Upsert).
 *
 * Both fields are `type: 'options'` with `typeOptions.loadOptionsMethod` — n8n renders these as
 * dropdowns whose choices are fetched at edit time by calling the named method under
 * `methods.loadOptions` on the node class (see Exasol.node.ts). Table additionally sets
 * `loadOptionsDependsOn: ['schema']`, which re-runs its loadOptions method (and clears the
 * current selection) whenever Schema changes, since the table list is schema-scoped.
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
		{
			displayName: 'Schema Name or ID',
			name: 'schema',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'listSchemas',
			},
			default: '',
			required: true,
			description: `Schema containing the table to ${verbPhrase}. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.`,
			displayOptions,
		},
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
