import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const DOCKER_IMAGE = 'exasol/docker-db:latest';
// 3 minutes: the documented startup is ~2 min; the extra minute absorbs slow CI runners.
const STARTUP_TIMEOUT_MS = 3 * 60 * 1000;

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
