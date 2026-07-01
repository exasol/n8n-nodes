import type {
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { ExasolDriver } from '@exasol/exasol-driver-ts';
import type { ExaWebsocket } from '@exasol/exasol-driver-ts';
import WebSocket from 'ws';

// Shape of the ExasolApi credential fields (mirrors ExasolApi.credentials.ts properties).
interface ExasolCredentials {
	host: string;
	port: number;
	user: string;
	password: string;
	schema: string;
}

// ws.WebSocket.readyState includes 0 (CONNECTING) which ExaWebsocket does not define,
// so the types don't align structurally. The cast through unknown is intentional.
function createWebsocketFactory() {
	return (url: string): ExaWebsocket => new WebSocket(url) as unknown as ExaWebsocket;
}

// Shared by both execute() and testExasolCredentials() to keep driver configuration in one place.
function buildDriver(creds: ExasolCredentials): ExasolDriver {
	return new ExasolDriver(createWebsocketFactory(), {
		host: creds.host,
		port: creds.port,
		user: creds.user,
		password: creds.password,
		schema: creds.schema || undefined, // empty string must not be passed to the driver
	});
}

export class Exasol implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Exasol',
		name: 'exasol',
		icon: { light: 'file:exasol.svg', dark: 'file:exasol.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Execute SQL queries against an Exasol database',
		subtitle: '={{$parameter["query"]}}',
		defaults: {
			name: 'Exasol',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// Marks the node as compatible with the AI tool-calling feature (n8n ≥ 1.25).
		usableAsTool: true,
		credentials: [
			{
				name: 'exasolApi',
				required: true,
				// Tells n8n to call testExasolCredentials() when the user clicks "Test credential".
				testedBy: 'testExasolCredentials',
			},
		],
		properties: [
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
			},
		],
	};

	// Called by n8n when the user clicks "Test credential" in the credential UI.
	// Opens a real WebSocket connection and runs SELECT 1 to verify reachability and auth.
	async testExasolCredentials(
		this: ICredentialTestFunctions,
		credential: ICredentialsDecrypted,
	): Promise<INodeCredentialTestResult> {
		// credential.data can be undefined in the type signature but is always populated here.
		const creds = credential.data as unknown as ExasolCredentials;
		const driver = buildDriver(creds);
		try {
			await driver.connect();
			await driver.query('SELECT 1');
			return { status: 'OK', message: 'Connection successful' };
		} catch (error) {
			return { status: 'Error', message: (error as Error).message };
		} finally {
			// Suppress errors from close() — the connection may already be broken at this point.
			await driver.close().catch(() => {});
		}
	}

	// A new connection is opened per execution. Exasol's driver does not expose a connection
	// pool that survives across n8n node invocations, so connect/close wraps every run.
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const credentials = await this.getCredentials('exasolApi');
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const driver = buildDriver(credentials as unknown as ExasolCredentials);

		try {
			await driver.connect();

			for (let i = 0; i < items.length; i++) {
				try {
					const query = this.getNodeParameter('query', i) as string;
					const result = await driver.query(query);
					// getRows() converts Exasol's columnar wire format to {columnName: value} objects.
					const rows = result.getRows();

					returnData.push(
						...rows.map((row) => ({
							json: row,
							pairedItem: { item: i },
						})),
					);
				} catch (error) {
					if (this.continueOnFail()) {
						// Preserve the item index in the output so downstream nodes can identify failures.
						returnData.push({
							json: { error: (error as Error).message },
							pairedItem: { item: i },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				}
			}
		} finally {
			// Always close the connection, even if an item threw and we bailed out early.
			await driver.close();
		}

		return [returnData];
	}
}
