import type { INodeProperties } from 'n8n-workflow';

import { schemaAndTableFields } from '../shared/schemaTableFields';
import { whereFields } from '../shared/whereFields';

// Shared by every property below — visible only when the Operation dropdown is "Update".
const displayOptions = {
	show: {
		operation: ['update'],
	},
};

/**
 * INodeProperties entries rendered when operation === 'update'.
 *
 * Update issues one UPDATE statement per n8n input item — unlike Insert, which batches every
 * item into a single multi-row statement, Update affects potentially many rows per item (one
 * WHERE match can select several rows), so each item's SET values and WHERE conditions are read
 * and executed independently. The SET clause is built the same way Insert builds its column
 * list: either from the input item's own JSON (Auto-Map Input Data) or an explicit list of
 * column/value pairs (Map Each Column Below). WHERE reuses the same fixed-collection shape as
 * Select Rows; it is required here — an empty Where would otherwise update every row in the
 * table, which execute.ts guards against at runtime.
 */
export const description: INodeProperties[] = [
	...schemaAndTableFields(displayOptions, 'update', 'update rows in'),
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
				description: "Use each input item's own JSON keys and values as the columns to set",
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
		// shape execute.ts's readSetColumns() consumes. "Value" is read per input item, so an
		// expression like ={{$json.name}} still resolves independently for each row.
		displayName: 'Columns',
		name: 'columns',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		default: {},
		placeholder: 'Add Column',
		description: 'Columns and values to set on each matching row',
		displayOptions: {
			show: {
				operation: ['update'],
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
						description: 'Name of the column to update',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Value to set the column to',
					},
				],
			},
		],
	},
	// Unlike Select Rows, an empty Where is rejected at runtime (see execute.ts): Update has no
	// "update all rows" mode.
	...whereFields(
		displayOptions,
		'updated',
		'Conditions a row must match to be updated. At least one condition is required, to guard against unintentionally updating every row in the table.',
	),
];
