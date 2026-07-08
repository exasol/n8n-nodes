import type { INodeProperties } from 'n8n-workflow';

import { schemaAndTableFields } from '../shared/schemaTableFields';
import { whereFields } from '../shared/whereFields';

// Shared by every property below — visible only when the Operation dropdown is "Select Rows".
const displayOptions = {
	show: {
		operation: ['selectRows'],
	},
};

/**
 * INodeProperties entries rendered when operation === 'selectRows'.
 *
 * Select Rows builds a SELECT statement from structured inputs instead of raw SQL: a
 * schema/table picker, optional WHERE conditions, optional sort rules, and a row limit.
 */
export const description: INodeProperties[] = [
	...schemaAndTableFields(displayOptions, 'select from', 'select rows from'),
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: true,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions,
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				operation: ['selectRows'],
				returnAll: [false],
			},
		},
	},
	...whereFields(
		displayOptions,
		'returned',
		'Conditions a row must match to be included in the results',
	),
	{
		displayName: 'Sort',
		name: 'sort',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		default: {},
		placeholder: 'Add Sort Rule',
		description: 'Columns to order the results by, in priority order',
		displayOptions,
		options: [
			{
				name: 'rules',
				displayName: 'Rule',
				values: [
					{
						displayName: 'Column',
						name: 'column',
						type: 'string',
						default: '',
						required: true,
						description: 'Column to sort by',
					},
					{
						displayName: 'Direction',
						name: 'direction',
						type: 'options',
						options: [
							{ name: 'ASC', value: 'ASC' },
							{ name: 'DESC', value: 'DESC' },
						],
						default: 'ASC',
					},
				],
			},
		],
	},
];
