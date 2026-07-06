import type { ExasolDriver } from '@exasol/exasol-driver-ts';
import type { StartedTestContainer } from 'testcontainers';

import { CONTAINER_HOOK_TIMEOUT_MS, startExasolContainer } from './containerSetup';
import { createSchema, dropSchema, openConnection } from './nodeTestHelper';

/**
 * Container, connection, and current schema shared by one `describe` block.
 * Populated by the `beforeAll`/`beforeEach` hooks registered in
 * `useExasolTestFixture` — read `container`/`connection`/`schema` only from
 * inside a `beforeEach`/`it`/`afterEach`, never during hook registration.
 */
export interface ExasolTestFixture {
	container: StartedTestContainer;
	connection: ExasolDriver;
	schema: string;
}

/**
 * Registers the `beforeAll`/`beforeEach`/`afterEach`/`afterAll` hooks shared by
 * every integration test suite: start (or reuse) the Exasol container, open a
 * direct driver connection, and create/drop a fresh schema per test.
 *
 * Call this at the top of a `describe` block, in place of hand-rolling the same
 * four hooks. Pass `setupData` to seed each fresh schema (e.g. with
 * `setupTestData`) right after it is created.
 *
 * @returns a fixture object whose `container`/`connection`/`schema` fields are
 * filled in by the hooks above — read them from within `it()` blocks.
 */
export function useExasolTestFixture(opts?: {
	setupData?: (connection: ExasolDriver, schema: string) => Promise<void>;
}): ExasolTestFixture {
	// Cast is safe: every field is assigned by beforeAll/beforeEach before any
	// it() block runs, matching Jest's hook execution order.
	const fixture = {} as ExasolTestFixture;

	beforeAll(async () => {
		fixture.container = await startExasolContainer();
		fixture.connection = await openConnection(fixture.container);
	}, CONTAINER_HOOK_TIMEOUT_MS);

	beforeEach(async () => {
		fixture.schema = await createSchema(fixture.connection);
		await opts?.setupData?.(fixture.connection, fixture.schema);
	});

	afterEach(async () => {
		await dropSchema(fixture.connection, fixture.schema);
	});

	afterAll(async () => {
		// Only close the driver connection here, not the container itself: the
		// container was started with .withReuse() in containerSetup.ts, so it is
		// intentionally left running for subsequent local test runs to reuse.
		await fixture.connection.close();
	});

	return fixture;
}
