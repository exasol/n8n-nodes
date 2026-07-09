import type { INodeProperties } from 'n8n-workflow';

import { schemaAndTableFields } from '../shared/schemaTableFields';

// Shared by every property below — visible only when the Operation dropdown is "Upsert".
const displayOptions = {
	show: {
		operation: ['upsert'],
	},
};

/**
 * INodeProperties entries rendered when operation === 'upsert'.
 *
 * Upsert batches every n8n input item into a single generated `MERGE` statement (one source row
 * per item), the same way Insert batches every item into one `INSERT` — see mergeBuilder.ts for
 * why Exasol needs a MERGE at all (it has no `INSERT ... ON CONFLICT`). Column mapping reuses
 * Insert's Data Mode / Columns pattern: either the input item's own JSON (Auto-Map Input Data) or
 * an explicit column/value collection (Map Each Column Below). "Conflict Columns" then picks
 * which of those mapped columns identify an existing row — they form the MERGE's `ON` clause,
 * while every other mapped column is written on a match.
 */
export const description: INodeProperties[] = [
	...schemaAndTableFields(displayOptions, 'upsert into', 'upsert rows into'),
	{
		// noDataExpression: true, like the "Operation" dropdown itself — this field decides which
		// other fields (Columns) are shown, so it must be a fixed choice, not data-driven.
		displayName: 'Data Mode',
		name: 'dataMode',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Auto-Map Input Data',
				value: 'autoMapInputData',
				description:
					"Use the first input item's JSON keys as the column list, and every item's own values as its row",
			},
			{
				name: 'Map Each Column Below',
				value: 'defineBelow',
				description: 'Set the column list and values explicitly, under Columns',
			},
		],
		default: 'autoMapInputData',
		description: 'Whether to map the input data automatically or define the columns manually',
		displayOptions,
	},
	{
		// A fixedCollection with multipleValues: true renders as a repeatable list of column rows.
		// n8n flattens this into { mappings: [{ column, value }, ...] } (or {} when empty) — the
		// shape execute.ts's readColumns()/buildRow() (shared/columnMappings.ts) consume. "Value" is
		// read per input item, so an expression like ={{$json.name}} still resolves independently
		// for each row.
		displayName: 'Columns',
		name: 'columns',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		default: {},
		placeholder: 'Add Column',
		description: 'Columns and values to upsert into each row',
		displayOptions: {
			show: {
				operation: ['upsert'],
				dataMode: ['defineBelow'],
			},
		},
		options: [
			{
				name: 'mappings',
				displayName: 'Column',
				values: [
					{
						displayName: 'Column',
						name: 'column',
						type: 'string',
						default: '',
						required: true,
						description: 'Name of the column to upsert',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Value to upsert into the column',
					},
				],
			},
		],
	},
	{
		// A plain `string` field with typeOptions.multipleValues: true renders as a repeatable list
		// of single-line text inputs and is read back as a string[] directly — unlike fixedCollection
		// above, there is no wrapping object to unwrap on the execute side.
		displayName: 'Conflict Columns',
		name: 'conflictColumns',
		type: 'string',
		typeOptions: {
			multipleValues: true,
		},
		default: [],
		placeholder: 'Add Column',
		required: true,
		description:
			'Column name(s), from the columns above, that identify an existing row. Forms the MERGE ON clause. Every other mapped column is written when a row matches; a row with no match is inserted.',
		displayOptions,
	},
];
