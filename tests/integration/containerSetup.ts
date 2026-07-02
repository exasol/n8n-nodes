import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

// exasol/docker-db uses a self-signed TLS certificate. Node.js rejects self-signed
// certs by default, which causes the Exasol WebSocket driver (wss://) to fail with
// E-EDJS-1. Setting this env var here disables TLS certificate validation for the
// entire integration test process. This module is only imported by *.itest.ts files,
// so it has no effect on production code or unit tests.
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
 * Starts an Exasol Docker container for integration tests.
 *
 * Uses `testcontainers` to pull and start `exasol/docker-db`. The container
 * is considered ready when its log emits "All stages finished" (~2 min).
 * `.withReuse()` keeps the container alive between local test runs so
 * subsequent runs skip the startup wait.
 *
 * Call this in `beforeAll()` of any integration test suite.
 */
export async function startExasolContainer(): Promise<StartedTestContainer> {
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
