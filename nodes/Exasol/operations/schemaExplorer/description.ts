import type { INodeProperties } from 'n8n-workflow';

import { schemaField } from '../shared/schemaTableFields';

// Unlike every other operations/<name>/description.ts, this one file covers three distinct
// operation values (per CLAUDE.md's Schema Explorer file layout: one description.ts + execute.ts
// pair for all of its sub-operations) — each field below is scoped to the specific sub-operation
// it applies to via its own displayOptions.show.
const LIST_TABLES_DISPLAY = { show: { operation: ['listTables'] } };
const DESCRIBE_TABLE_DISPLAY = { show: { operation: ['describeTable'] } };

/**
 * INodeProperties entries rendered when operation is one of the three Schema Explorer
 * operations: List Schemas (no fields of its own — nothing to add here), List Tables, and
 * Describe Table.
 */
export const description: INodeProperties[] = [
	// List Schemas has no parameters, so it contributes no fields here.

	// List Tables
	schemaField(LIST_TABLES_DISPLAY, 'list tables from'),
	{
		displayName: 'Include Views',
		name: 'includeViews',
		type: 'boolean',
		default: false,
		description: 'Whether to include views alongside tables in the results',
		displayOptions: LIST_TABLES_DISPLAY,
	},

	// Describe Table
	schemaField(DESCRIBE_TABLE_DISPLAY, 'describe a table or view from'),
	{
		displayName: 'Table or View Name or ID',
		name: 'table',
		type: 'options',
		typeOptions: {
			// Distinct from the "listTables" method used by Select/Insert/Update/Delete/Upsert's
			// Table field: those write operations only ever target a table, but Describe Table
			// should be able to describe a view too, so its picker draws from both EXA_ALL_TABLES
			// and EXA_ALL_VIEWS (see the listTablesAndViews loadOptions method in Exasol.node.ts).
			loadOptionsMethod: 'listTablesAndViews',
			loadOptionsDependsOn: ['schema'],
		},
		default: '',
		required: true,
		description:
			'Table or view to describe. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: DESCRIBE_TABLE_DISPLAY,
	},
];
