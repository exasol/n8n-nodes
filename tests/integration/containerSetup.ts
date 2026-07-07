import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

// exasol/docker-db uses a self-signed TLS certificate. The Exasol WebSocket driver
// connects via wss:// and would fail with E-EDJS-1 if the cert is rejected.
// ws calls tls.connect() directly (bypassing https.request), so the env var alone
// does not disable cert validation — Exasol.node.ts and openConnection() each read
// it explicitly and forward rejectUnauthorized: false to the WebSocket constructor.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DOCKER_IMAGE = 'exasol/docker-db:2026.1.0';
// 3 minutes: the documented startup is ~2 min; the extra minute absorbs slow CI runners.
const STARTUP_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The minimum Jest hook timeout (in ms) for any `beforeAll` that calls
 * `startExasolContainer`. Pass this as the second argument to `beforeAll`
 * to prevent Jest from killing the hook before the container is ready.
 *
 * Adds a 30-second buffer on top of the container startup timeout to allow
 * for `openConnection` and other setup work.
 */
export const CONTAINER_HOOK_TIMEOUT_MS = STARTUP_TIMEOUT_MS + 30_000;

/**
 * Points integration tests at an Exasol instance that is already running (e.g. in a VM or a
 * colleague's machine) instead of starting a local Docker container — for development machines
 * where Docker itself isn't available. Only `getHost()`/`getMappedPort()` are ever called on the
 * returned value (see `getContainerCredentials` in nodeTestHelper.ts), so a plain object
 * satisfying those two methods stands in for a real `StartedTestContainer`.
 */
function externalContainerFromEnv(): StartedTestContainer | undefined {
	const host = process.env.EXASOL_TEST_HOST;
	const port = process.env.EXASOL_TEST_PORT;
	if (!host || !port) return undefined;

	return {
		getHost: () => host,
		getMappedPort: () => Number(port),
	} as unknown as StartedTestContainer;
}

/**
 * Starts an Exasol Docker container for integration tests.
 *
 * Uses `testcontainers` to pull and start `exasol/docker-db`. The container
 * is considered ready when its log emits "All stages finished" (~2 min).
 * `.withReuse()` keeps the container alive between local test runs so
 * subsequent runs skip the startup wait.
 *
 * When `EXASOL_TEST_HOST` and `EXASOL_TEST_PORT` are both set, skips Docker entirely and
 * connects to that instance instead (see `externalContainerFromEnv` above).
 *
 * Call this in `beforeAll()` of any integration test suite.
 */
export async function startExasolContainer(): Promise<StartedTestContainer> {
	const external = externalContainerFromEnv();
	if (external) {
		console.log(
			`Using external Exasol instance at ${process.env.EXASOL_TEST_HOST}:${process.env.EXASOL_TEST_PORT} ` +
				'(EXASOL_TEST_HOST/EXASOL_TEST_PORT set) instead of starting a Docker container.',
		);
		return external;
	}

	const containerLog: string[] = [];

	const container = new GenericContainer(DOCKER_IMAGE)
		.withExposedPorts(8563, 2580)
		.withPrivilegedMode()
		.withDefaultLogDriver()
		.withReuse()
		.withStartupTimeout(STARTUP_TIMEOUT_MS)
		.withLogConsumer((stream) => {
			stream.on('data', (line: Buffer) => containerLog.push(line.toString()));
		})
		.withWaitStrategy(Wait.forLogMessage('All stages finished'));

	try {
		console.log(`Starting ${DOCKER_IMAGE} (timeout: ${STARTUP_TIMEOUT_MS / 1000}s)...`);
		return await container.start();
	} catch (error) {
		console.error('Failed to start Exasol container:', error);
		console.error('Container logs:\n', containerLog.join(''));
		throw error;
	}
}
