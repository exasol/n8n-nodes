import type {
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { ExasolDriver } from '@exasol/exasol-driver-ts';
import type { ExaWebsocket } from '@exasol/exasol-driver-ts';
import WebSocket from 'ws';

import {
	executeQueryDescription,
	executeQuery,
	selectRowsDescription,
	selectRows,
	insertDescription,
	insert,
	updateDescription,
	update,
	deleteDescription,
	deleteRows,
	upsertDescription,
	upsert,
	schemaExplorerDescription,
	schemaExplorer,
	SCHEMA_EXPLORER_OPERATIONS,
} from './operations';
import { runRows, type QueryRow } from './operations/shared/statementRunner';

// Shape of the ExasolApi credential fields (mirrors ExasolApi.credentials.ts properties).
interface ExasolCredentials {
	host: string;
	port: number;
	user: string;
	password: string;
	schema: string;
	resultSetMaxRows: number;
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
		// 0 means "no limit" at the node/credential layer; the driver itself treats
		// resultSetMaxRows: 0 as "fetch zero rows", so 0 must never be passed through literally.
		resultSetMaxRows: creds.resultSetMaxRows || undefined,
	});
}

// Shared by listTables and listTablesAndViews below, whose only difference is the query text:
// opens a short-lived connection, runs a single-column SELECT via runRows() (shared/
// statementRunner.ts — the same prepare/execute/raw-vs-prepared branching and row pivot used by
// Schema Explorer), and reads out the one selected column. Object.values(row)[0] rather than a
// hardcoded column name, since listTablesAndViews' UNION ALL query's column name depends on its
// first branch's alias. runRows already throws a descriptive Error (the driver's own exception
// text, or a generic fallback) on failure — this just re-wraps it as a NodeOperationError so it
// surfaces correctly in the editor UI.
// The driver.close() cleanup here (and stmt.close() inside runRows) can be simplified once
// automatic resource cleanup is implemented in the driver, see
// https://github.com/exasol/exasol-driver-ts/issues/73.
async function fetchFirstColumnOptions(
	this: ILoadOptionsFunctions,
	query: string,
	params: unknown[],
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('exasolApi');
	const driver = buildDriver(credentials as unknown as ExasolCredentials);
	try {
		await driver.connect();
		let rows: QueryRow[];
		try {
			rows = await runRows(driver, query, params);
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error);
		}
		return rows.map((row) => {
			const name = Object.values(row)[0] as string;
			return { name, value: name };
		});
	} finally {
		await driver.close().catch(() => {});
	}
}

// Membership check backing the dispatch branch for the three Schema Explorer sub-operations,
// which — unlike every other operation value — all route to the single schemaExplorer() function
// rather than each having its own dedicated execute().
const SCHEMA_EXPLORER_OPERATION_SET: ReadonlySet<string> = new Set(SCHEMA_EXPLORER_OPERATIONS);

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
		subtitle:
			'={{$parameter["operation"] === "executeQuery" ? $parameter["query"] : $parameter["operation"]}}',
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
						name: 'Create or Update',
						value: 'upsert',
						description:
							'Create a new record, or update the current one if it already exists (upsert)',
						action: 'Upsert rows',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete rows from a table using structured filters',
						action: 'Delete rows',
					},
					{
						name: 'Describe Table',
						value: 'describeTable',
						description: "Describe a table or view's columns and constraints",
						action: 'Describe a table',
					},
					{
						name: 'Execute Query',
						value: 'executeQuery',
						description: 'Execute one or more SQL statements',
						action: 'Execute a query',
					},
					{
						name: 'Insert',
						value: 'insert',
						description: 'Insert rows into a table',
						action: 'Insert rows',
					},
					{
						name: 'List Schemas',
						value: 'listSchemas',
						description: 'List all schemas in the database',
						action: 'List schemas',
					},
					{
						name: 'List Tables',
						value: 'listTables',
						description: 'List tables (and optionally views) in a schema',
						action: 'List tables',
					},
					{
						name: 'Select Rows',
						value: 'selectRows',
						description: 'Select rows from a table using structured filters',
						action: 'Select rows',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update rows in a table using structured filters',
						action: 'Update rows',
					},
				],
				default: 'executeQuery',
			},
			...executeQueryDescription,
			...selectRowsDescription,
			...insertDescription,
			...updateDescription,
			...deleteDescription,
			...upsertDescription,
			...schemaExplorerDescription,
		],
	};

	// Populates the Schema / Table dropdowns in selectRows/description.ts (and reused by later
	// operations). loadOptions methods run in the n8n editor UI, not during execute() — each one
	// opens and closes its own short-lived connection rather than sharing execute()'s driver.
	methods = {
		loadOptions: {
			async listSchemas(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('exasolApi');
				const driver = buildDriver(credentials as unknown as ExasolCredentials);
				try {
					await driver.connect();
					const result = await driver.query(
						'SELECT SCHEMA_NAME FROM EXA_ALL_SCHEMAS ORDER BY SCHEMA_NAME',
					);
					return result.getRows().map((row) => {
						const name = row.SCHEMA_NAME as string;
						return { name, value: name };
					});
				} finally {
					await driver.close().catch(() => {});
				}
			},

			async listTables(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				// getCurrentNodeParameter (unlike getNodeParameter) reads the value currently set
				// in the editor UI for this node, with no item index — loadOptions runs once per
				// dropdown open, not once per input item.
				const schema = this.getCurrentNodeParameter('schema') as string | undefined;
				if (!schema) return [];

				return fetchFirstColumnOptions.call(
					this,
					'SELECT TABLE_NAME FROM EXA_ALL_TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
					[schema],
				);
			},

			// Backs Describe Table's "table" field. Distinct from listTables above: that method
			// (used by the write operations and List Tables) only offers tables, but Describe
			// Table should be able to describe a view too, so this draws from both EXA_ALL_TABLES
			// and EXA_ALL_VIEWS via UNION ALL. ORDER BY 1 (rather than a column name) avoids
			// relying on which branch's column alias the union result inherits.
			async listTablesAndViews(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const schema = this.getCurrentNodeParameter('schema') as string | undefined;
				if (!schema) return [];

				return fetchFirstColumnOptions.call(
					this,
					'SELECT TABLE_NAME FROM EXA_ALL_TABLES WHERE TABLE_SCHEMA = ? UNION ALL SELECT VIEW_NAME FROM EXA_ALL_VIEWS WHERE VIEW_SCHEMA = ? ORDER BY 1',
					[schema, schema],
				);
			},
		},

		// n8n resolves a credential's `testedBy` string (see the `credentials` array above) by
		// looking up `node.methods.credentialTest[testedBy]` — the function must live under this
		// nested key, not as a plain class method, or the "Test" button in the credential UI
		// finds nothing to call.
		credentialTest: {
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
			},
		},
	};

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

			// Per-item errors inside each operation handler are handled there: they check
			// continueOnFail() and return error items rather than throwing, so nothing re-wraps
			// them here.
			if (operation === 'executeQuery') {
				return [await executeQuery.call(this, driver, items)];
			} else if (operation === 'selectRows') {
				return [await selectRows.call(this, driver, items)];
			} else if (operation === 'insert') {
				return [await insert.call(this, driver, items)];
			} else if (operation === 'update') {
				return [await update.call(this, driver, items)];
			} else if (operation === 'delete') {
				return [await deleteRows.call(this, driver, items)];
			} else if (operation === 'upsert') {
				return [await upsert.call(this, driver, items)];
			} else if (SCHEMA_EXPLORER_OPERATION_SET.has(operation)) {
				return [
					await schemaExplorer.call(
						this,
						driver,
						items,
						operation as (typeof SCHEMA_EXPLORER_OPERATIONS)[number],
					),
				];
			} else {
				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
			}
		} finally {
			// Suppress close() errors — the real error (if any) has already propagated above.
			await driver.close().catch(() => {});
		}
	}
}
