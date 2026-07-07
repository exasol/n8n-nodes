import type { INodeProperties } from 'n8n-workflow';

import { schemaAndTableFields } from '../shared/schemaTableFields';

// Shared by every property below — visible only when the Operation dropdown is "Insert".
const displayOptions = {
	show: {
		operation: ['insert'],
	},
};

/**
 * INodeProperties entries rendered when operation === 'insert'.
 *
 * Insert batches every n8n input item into a single INSERT statement. Column values for each
 * row come from either the input item's own JSON (Auto-Map Input Data) or an explicit list of
 * column/value pairs configured on the node (Map Each Column Below).
 */
export const description: INodeProperties[] = [
	...schemaAndTableFields(displayOptions, 'insert into', 'insert rows into'),
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
		// shape execute.ts's readColumns()/buildRow() consume. "Value" is read per input item, so
		// an expression like ={{$json.name}} still resolves independently for each row.
		displayName: 'Columns',
		name: 'columns',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		default: {},
		placeholder: 'Add Column',
		description: 'Columns and values to insert into each row',
		displayOptions: {
			show: {
				operation: ['insert'],
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
						description: 'Name of the column to insert into',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Value to insert into the column',
					},
				],
			},
		],
	},
];
