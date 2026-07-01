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
];
