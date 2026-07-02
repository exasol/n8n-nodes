import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		rules: {
			// The Exasol driver and ws are required runtime dependencies for this node.
			// The no-runtime-dependencies rule targets n8n Cloud compatibility, which is
			// not a goal for this self-hosted integration package.
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
		},
	},
	{
		// Test infrastructure is not n8n node code: it has no node context, no
		// IExecuteFunctions, and no getNode(). The n8n-specific rules that require
		// NodeApiError/NodeOperationError do not apply here, and console output is
		// the standard way to report container startup progress in test helpers.
		files: ['tests/**'],
		rules: {
			'no-console': 'off',
			'@n8n/community-nodes/require-node-api-error': 'off',
		},
	},
];
