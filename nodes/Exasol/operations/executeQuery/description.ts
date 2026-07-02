import type { INodeProperties } from 'n8n-workflow';

/**
 * INodeProperties entries rendered when operation === 'executeQuery'.
 *
 * In n8n, displayOptions.show controls field visibility: these properties
 * appear in the node UI only when the user has selected "Execute Query"
 * from the Operation dropdown.
 */
export const description: INodeProperties[] = [
	{
		displayName: 'SQL Query',
		name: 'query',
		type: 'string',
		typeOptions: {
			rows: 5,
		},
		default: '',
		required: true,
		placeholder: 'SELECT * FROM my_schema.my_table LIMIT 100',
		description: 'SQL statement to execute against Exasol',
		noDataExpression: false,
		displayOptions: {
			show: {
				operation: ['executeQuery'],
			},
		},
	},
];
