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

import { executeQueryDescription, executeQuery } from './operations';

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
//
// NODE_TLS_REJECT_UNAUTHORIZED=0 is the conventional signal to disable certificate
// validation (e.g. when connecting to a server with a self-signed cert). ws bypasses
// Node.js's https.request option-processing and calls tls.connect() directly, so
// the env var has no automatic effect — we must read it explicitly and forward it.
function createWebsocketFactory() {
	const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
	return (url: string): ExaWebsocket =>
		new WebSocket(url, { rejectUnauthorized }) as unknown as ExaWebsocket;
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

/**
 * n8n community node for Exasol. Implements INodeType — the interface n8n uses to discover,
 * configure, and execute community nodes. Provides credential testing and delegates workflow
 * executions to the appropriate operation handler in operations/.
 */
export class Exasol implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Exasol',
		name: 'exasol',
		icon: { light: 'file:exasol.svg', dark: 'file:exasol.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Execute SQL queries against an Exasol database',
		// For Execute Query the subtitle shows the SQL text (most informative per-operation value).
		// For future operations this falls back to the raw operation key.
		subtitle: '={{$parameter["operation"] === "executeQuery" ? $parameter["query"] : $parameter["operation"]}}',
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
				// The operation dropdown is the structural entry point for the node: its value
				// determines which other fields are displayed (via displayOptions.show on each
				// operation's description). noDataExpression: true prevents users from setting
				// this via an n8n expression — the operation choice is not data-driven.
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Execute Query',
						value: 'executeQuery',
						description: 'Execute one or more SQL statements',
						action: 'Execute a query',
					},
				],
				default: 'executeQuery',
			},
			...executeQueryDescription,
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
		// Read the operation from item 0 — operation is noDataExpression: true, meaning it cannot
		// be set via an expression and is therefore identical for all items; item 0 is safe.
		const operation = this.getNodeParameter('operation', 0) as string;

		const driver = buildDriver(credentials as unknown as ExasolCredentials);

		try {
			// Connection failures are separated from per-item failures: a broken connection
			// affects all items, so we surface one error item per input item (not just item 0).
			try {
				await driver.connect();
			} catch (error) {
				if (this.continueOnFail()) {
					return [
						items.map((_, i) => ({
							json: { error: (error as Error).message },
							pairedItem: { item: i },
						})),
					];
				}
				throw new NodeOperationError(this.getNode(), error as Error);
			}

			/* istanbul ignore else — only executeQuery exists; the else is a compile-time safety net */
			if (operation === 'executeQuery') {
				// Per-item errors inside executeQuery are handled there: it checks continueOnFail()
				// and returns error items rather than throwing, so nothing re-wraps them here.
				return [await executeQuery.call(this, driver, items)];
			} else {
				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
			}
		} finally {
			// Suppress close() errors — the real error (if any) has already propagated above.
			await driver.close().catch(() => {});
		}
	}
}
