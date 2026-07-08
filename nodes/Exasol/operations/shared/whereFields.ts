import type { INodeProperties } from 'n8n-workflow';

/**
 * Builds the "Combine Conditions" and "Where" fields shared by every operation that filters rows
 * with a fixed-collection of conditions (Select Rows, Update, and — in later PRs — Delete).
 *
 * A fixedCollection with multipleValues: true renders as a repeatable list of condition rows.
 * n8n flattens this into { conditions: [{ column, operator, value }, ...] } (or {} when empty) —
 * the shape whereBuilder.ts's buildWhereClause() consumes.
 *
 * @param displayOptions - visibility condition shared with the rest of the operation's fields
 * @param verb - past-tense verb describing what happens to matching rows, e.g. "returned" or
 *   "updated" — used in the Combine Conditions option descriptions
 * @param whereDescription - help text for the Where field itself, since operations differ on
 *   whether an empty Where is allowed (Select Rows) or rejected at runtime (Update, Delete)
 */
export function whereFields(
	displayOptions: INodeProperties['displayOptions'],
	verb: string,
	whereDescription: string,
): INodeProperties[] {
	return [
		{
			displayName: 'Combine Conditions',
			name: 'combineConditions',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'AND',
					value: 'AND',
					description: `Only rows matching all conditions in Where are ${verb}`,
				},
				{
					name: 'OR',
					value: 'OR',
					description: `Rows matching any condition in Where are ${verb}`,
				},
			],
			default: 'AND',
			description: 'How to combine multiple conditions in Where',
			displayOptions,
		},
		{
			displayName: 'Where',
			name: 'where',
			type: 'fixedCollection',
			typeOptions: {
				multipleValues: true,
			},
			default: {},
			placeholder: 'Add Condition',
			description: whereDescription,
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
								{
									name: 'Greater Than or Equal',
									value: 'greaterThanOrEqual',
									description: '≥',
								},
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
	];
}
