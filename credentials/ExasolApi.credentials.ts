import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ExasolApi implements ICredentialType {
	name = 'exasolApi';

	displayName = 'Exasol API';

	// Path is relative to this file; the SVG lives with the node, not in a separate icons/ dir.
	icon = 'file:../nodes/Exasol/exasol.svg' as const;

	documentationUrl = 'https://github.com/exasol/n8n-nodes';

	// Delegates credential testing to Exasol.testExasolCredentials(), which opens a real
	// WebSocket connection. An HTTP-based test property is not viable for a database driver.
	testedBy = 'exasol';

	properties: INodeProperties[] = [
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'exasol.example.com',
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			// Exasol's default WebSocket SQL API port.
			default: 8563,
			required: true,
		},
		{
			displayName: 'User',
			name: 'user',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Schema',
			name: 'schema',
			type: 'string',
			default: '',
			description: 'Default schema for queries (optional)',
		},
	];
}
