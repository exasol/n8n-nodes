import type { INodeProperties } from 'n8n-workflow';

import { schemaAndTableFields } from '../shared/schemaTableFields';

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
	{
		displayName: 'Combine Conditions',
		name: 'combineConditions',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'AND',
				value: 'AND',
				description: 'Only rows matching all conditions in Where are returned',
			},
			{
				name: 'OR',
				value: 'OR',
				description: 'Rows matching any condition in Where are returned',
			},
		],
		default: 'AND',
		description: 'How to combine multiple conditions in Where',
		displayOptions,
	},
	{
		// A fixedCollection with multipleValues: true renders as a repeatable list of
		// condition rows. n8n flattens this into { conditions: [{ column, operator, value }, ...] }
		// (or {} when empty) — the shape whereBuilder.ts's buildWhereClause() consumes.
		displayName: 'Where',
		name: 'where',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		default: {},
		placeholder: 'Add Condition',
		description: 'Conditions a row must match to be included in the results',
		displayOptions,
		options: [
			{
				name: 'conditions',
				displayName: 'Condition',
				values: [
					{
						displayName: 'Column',
						name: 'column',
						type: 'string',
						default: '',
						required: true,
						description: 'Column to filter on',
					},
					{
						displayName: 'Operator',
						name: 'operator',
						type: 'options',
						options: [
							{ name: 'Equals', value: 'equals', description: '=' },
							{ name: 'Greater Than', value: 'greaterThan', description: '>' },
							{ name: 'Greater Than or Equal', value: 'greaterThanOrEqual', description: '≥' },
							{ name: 'Is Not Null', value: 'isNotNull' },
							{ name: 'Is Null', value: 'isNull' },
							{ name: 'Less Than', value: 'lessThan', description: '<' },
							{ name: 'Less Than or Equal', value: 'lessThanOrEqual', description: '≤' },
							{ name: 'Like', value: 'like' },
							{ name: 'Not Equals', value: 'notEquals', description: '≠' },
							{ name: 'Not Like', value: 'notLike' },
							{
								name: 'Not Regexp Like',
								value: 'notRegexpLike',
								description: 'String does not match a regular expression',
							},
							{
								name: 'Regexp Like',
								value: 'regexpLike',
								description: 'String matches a regular expression',
							},
						],
						default: 'equals',
						description: 'Comparison used between the column and Value',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description:
							'Value to compare against. Ignored when Operator is Is Null or Is Not Null.',
					},
				],
			},
		],
	},
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
