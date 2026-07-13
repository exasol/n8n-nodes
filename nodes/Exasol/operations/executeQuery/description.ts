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
		description: 'SQL statement to execute against Exasol. Use ? for parameter placeholders.',
		noDataExpression: false,
		displayOptions: {
			show: {
				operation: ['executeQuery'],
			},
		},
	},
	{
		// noDataExpression: true is a *security* requirement here, not just a UI nicety — this
		// node is usableAsTool: true, and any field with noDataExpression: false is fillable by
		// an AI agent driving the tool (like the "SQL Query" field above). If this flag could
		// itself be set via an expression/AI input, an agent could flip it to false and defeat
		// the guard entirely, so it must stay a workflow-design-time-only setting, same as
		// Execution Mode below.
		displayName: 'Restrict to SELECT Queries',
		name: 'restrictToSelect',
		type: 'boolean',
		default: true,
		noDataExpression: true,
		description:
			'Whether to reject any query that is not a read-only SELECT (or WITH ... SELECT) ' +
			'statement before it reaches the database. Recommended when this node is exposed to an ' +
			'AI agent or other freeform SQL input. Disable only for trusted workflows that need ' +
			'Execute Query to run INSERT/UPDATE/DELETE/DDL statements.',
		displayOptions: {
			show: {
				operation: ['executeQuery'],
			},
		},
	},
	{
		// A fixedCollection with multipleValues: true renders as a repeatable list of
		// entries; here each entry holds a single scalar value bound to the next ?
		// placeholder in the query, from left to right.
		displayName: 'Parameters',
		name: 'parameters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		description: 'Values bound to ? placeholders in the SQL query, in order from left to right',
		displayOptions: {
			show: {
				operation: ['executeQuery'],
			},
		},
		options: [
			{
				name: 'values',
				displayName: 'Values',
				values: [
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Value for this placeholder position. Supports n8n expressions.',
					},
				],
			},
		],
	},
	{
		// noDataExpression: true prevents this field from being set via an n8n expression
		// — the execution mode is a workflow design decision, not data-driven.
		displayName: 'Execution Mode',
		name: 'executionMode',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Sequentially',
				value: 'sequentially',
				description:
					'Each input item runs its own auto-committed query; errors stop processing unless continueOnFail is enabled',
			},
			{
				name: 'Transaction',
				value: 'transaction',
				description:
					'All input items execute in a single DB transaction; any failure rolls back all',
			},
			{
				name: 'Single Batch',
				value: 'single',
				description:
					'All input items are sent in one batch (one round-trip); only works when no item uses Parameters (falls back to Sequentially otherwise); if the batch fails, every item is reported as failed with the same error, since it cannot be attributed to a specific one',
			},
		],
		default: 'sequentially',
		description: 'How to handle multiple input items',
		displayOptions: {
			show: {
				operation: ['executeQuery'],
			},
		},
	},
];
