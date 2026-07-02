import { randomUUID } from 'crypto';

import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { ExasolDriver } from '@exasol/exasol-driver-ts';
import type { ExaWebsocket } from '@exasol/exasol-driver-ts';
import WebSocket from 'ws';

import type { StartedTestContainer } from 'testcontainers';

// Default credentials for exasol/docker-db.
const DOCKER_DB_USER = 'sys';
const DOCKER_DB_PASSWORD = 'exasol';

/** Connection details extracted from a running testcontainers container. */
export interface ContainerCredentials {
	host: string;
	port: number;
	user: string;
	password: string;
}

/**
 * Returns the host/port/user/password needed to connect to the Exasol
 * container started by `startExasolContainer()`. The port is the host-side
 * mapped port for the container's 8563 listener.
 */
export function getContainerCredentials(container: StartedTestContainer): ContainerCredentials {
	return {
		host: container.getHost(),
		port: container.getMappedPort(8563),
		user: DOCKER_DB_USER,
		password: DOCKER_DB_PASSWORD,
	};
}

/**
 * Opens a direct `ExasolDriver` connection to the container. Use this in
 * `beforeEach`/`afterEach` to run DDL (CREATE SCHEMA, INSERT, DROP …)
 * without going through the n8n node layer.
 *
 * The caller is responsible for calling `driver.close()` when done.
 */
export async function openConnection(container: StartedTestContainer): Promise<ExasolDriver> {
	const creds = getContainerCredentials(container);
	// ws.WebSocket does not structurally match ExaWebsocket (missing readyState=0),
	// so the cast through unknown is intentional — same pattern as Exasol.node.ts.
	const wsFactory = (url: string): ExaWebsocket => new WebSocket(url) as unknown as ExaWebsocket;
	const driver = new ExasolDriver(wsFactory, {
		host: creds.host,
		port: creds.port,
		user: creds.user,
		password: creds.password,
	});
	await driver.connect();
	return driver;
}

/**
 * Creates a uniquely named schema in the container and returns its name.
 * Intended for use in `beforeEach` to give each test a clean, isolated
 * schema that can be dropped in `afterEach` without affecting other tests.
 */
export async function createSchema(driver: ExasolDriver): Promise<string> {
	const name = 'TEST_' + randomUUID().replace(/-/g, '').toUpperCase().substring(0, 16);
	await driver.execute(`CREATE SCHEMA ${name}`);
	return name;
}

/**
 * Drops the schema and all its objects. Call in `afterEach` to keep the
 * database clean between test runs.
 */
export async function dropSchema(driver: ExasolDriver, schema: string): Promise<void> {
	await driver.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

/**
 * A factory function that returns a different value per input-item index.
 * Use this in `params` when the same parameter needs a distinct value for
 * each n8n input item — e.g. a per-row query string.
 *
 * Example: `params: { query: perItem(['SELECT 1', 'SELECT 2']) }`
 */
export function perItem<T>(values: T[]): (itemIndex: number) => T {
	return (itemIndex: number) => values[itemIndex];
}

/**
 * Options for `buildExecuteFunctions`. `params` maps n8n parameter names to
 * their values. Pass a plain value (including arrays) for parameters that are
 * the same across all items; use `perItem([...])` for parameters that vary
 * per input item.
 *
 * This mirrors the `makeContext` helper in unit tests but substitutes real
 * container credentials instead of hardcoded placeholders.
 */
export interface ExecuteFunctionsOpts {
	/** The container whose credentials populate `getCredentials('exasolApi')`. */
	container: StartedTestContainer;
	/** n8n input items. Defaults to a single item with an empty json object. */
	items?: INodeExecutionData[];
	/** Value returned by `getNodeParameter('operation', 0)`. Defaults to 'executeQuery'. */
	operation?: string;
	/**
	 * Values returned by `getNodeParameter(name, itemIndex)`.
	 * Scalar and array values are returned as-is for every item.
	 * Pass `perItem([v0, v1, ...])` to return a different value per item index.
	 */
	params?: Record<string, unknown | ((itemIndex: number) => unknown)>;
	/** Value returned by `continueOnFail()`. Defaults to false. */
	continueOnFail?: boolean;
}

/**
 * Creates a mock `IExecuteFunctions` wired to a real container for integration tests.
 *
 * `IExecuteFunctions` is the context object n8n passes into `node.execute()`.
 * It provides credential lookup, input item access, and per-item parameter
 * reads. The mock here satisfies the same interface the real n8n runtime
 * provides, so the node code under test is exercised unmodified.
 */
export function buildExecuteFunctions(opts: ExecuteFunctionsOpts): IExecuteFunctions {
	const creds = getContainerCredentials(opts.container);
	const items = opts.items ?? [{ json: {} }];

	return {
		// getCredentials is called by Exasol.node.ts to retrieve the saved
		// database connection details. Returns the container's live host/port.
		getCredentials: jest.fn().mockResolvedValue({ ...creds, schema: '' }),

		// getInputData returns the list of items flowing into the node from the
		// previous workflow step. Tests can supply custom items; defaults to one.
		getInputData: jest.fn().mockReturnValue(items),

		// getNodeParameter reads a UI field value for a specific input item.
		// The item index is needed because fields can be set via n8n expressions
		// (e.g. ={{$json.query}}) that evaluate differently per item.
		// The optional third argument is the fallback value n8n returns when the
		// parameter has not been set by the user.
		getNodeParameter: jest.fn().mockImplementation(
			(name: string, itemIndex?: number, fallback?: unknown) => {
				if (name === 'operation') return opts.operation ?? 'executeQuery';
				const val = opts.params?.[name];
				if (val === undefined) return fallback;
				if (typeof val === 'function') return (val as (i: number) => unknown)(itemIndex ?? 0);
				return val;
			},
		),

		// continueOnFail controls whether a per-item error produces an error output
		// item (true) or throws and aborts the whole execution (false).
		continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),

		getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
	} as unknown as IExecuteFunctions;
}
