import type { StartedTestContainer } from 'testcontainers';

import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { startExasolContainer, CONTAINER_HOOK_TIMEOUT_MS } from './containerSetup';
import {
	buildExecuteFunctions,
	createSchema,
	dropSchema,
	openConnection,
	perItem,
} from './nodeTestHelper';
import { setupTestData } from './testData';
import type { ExasolDriver } from '@exasol/exasol-driver-ts';

describe('Execute Query operation', () => {
	let container: StartedTestContainer;
	let connection: ExasolDriver;
	let schema: string;

	beforeAll(async () => {
		container = await startExasolContainer();
		connection = await openConnection(container);
	}, CONTAINER_HOOK_TIMEOUT_MS);

	beforeEach(async () => {
		schema = await createSchema(connection);
		await setupTestData(connection, schema);
	});

	afterEach(async () => {
		await dropSchema(connection, schema);
	});

	afterAll(async () => {
		await connection.close();
	});

	// ── Basic execution ─────────────────────────────────────────────────────────

	it('executes SELECT 1 and returns a row', async () => {
		const ctx = buildExecuteFunctions({
			container,
			params: { query: 'SELECT 1 AS N' },
		});
		const [[item]] = await new Exasol().execute.call(ctx);

		expect(Number(item.json.N)).toBe(1);
	});

	it('raw-path DML returns { affectedRows: N }', async () => {
		// No parameters → raw path; INSERT is non-SELECT → driver.query(..., 'raw') → rowCount.
		// COMPETITIONS references SKI_RUN via FK; (1000, 'Christine') is a valid pair.
		const ctx = buildExecuteFunctions({
			container,
			params: {
				query: `INSERT INTO ${schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
			},
		});
		const [[item]] = await new Exasol().execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 1 });
	});

	// ── Parameterized path ──────────────────────────────────────────────────────

	it('parameterized INSERT returns { affectedRows: 1 }', async () => {
		const ctx = buildExecuteFunctions({
			container,
			params: {
				query: `INSERT INTO ${schema}.COMPETITIONS VALUES (?, ?, ?, ?)`,
				parameters: {
					values: [{ value: 'FIS WC' }, { value: 2024 }, { value: 1000 }, { value: 'Christine' }],
				},
			},
		});
		const [[item]] = await new Exasol().execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 1 });
	});

	it('parameterized INSERT then SELECT verifies round-trip', async () => {
		const insertCtx = buildExecuteFunctions({
			container,
			params: {
				query: `INSERT INTO ${schema}.COMPETITIONS VALUES (?, ?, ?, ?)`,
				parameters: {
					values: [{ value: 'FIS WC' }, { value: 2024 }, { value: 1000 }, { value: 'Christine' }],
				},
			},
		});
		await new Exasol().execute.call(insertCtx);

		// Verify the row is actually in the database via a direct connection query.
		const rows = (
			await connection.query(`SELECT SERIES, YEAR FROM ${schema}.COMPETITIONS ORDER BY SERIES`)
		).getRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].SERIES).toBe('FIS WC');
		expect(Number(rows[0].YEAR)).toBe(2024);
	});

	it('parameterized SELECT filters rows with a bound value', async () => {
		// SKI_RESORT is pre-populated by setupTestData with three resorts; select one by ID.
		const ctx = buildExecuteFunctions({
			container,
			params: {
				query: `SELECT RESORT_ID, RESORT_NAME FROM ${schema}.SKI_RESORT WHERE RESORT_ID = ?`,
				parameters: { values: [{ value: 1000 }] },
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(1);
		expect(Number(result[0].json.RESORT_ID)).toBe(1000);
		expect(result[0].json.RESORT_NAME).toBe('Val Thorens');
	});

	// ── Transaction mode ────────────────────────────────────────────────────────

	it('transaction mode commits all items when all succeed', async () => {
		const ctx = buildExecuteFunctions({
			container,
			items: [{ json: {} }, { json: {} }],
			params: {
				executionMode: 'transaction',
				query: perItem([
					`INSERT INTO ${schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
					`INSERT INTO ${schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Allamande')`,
				]),
			},
		});
		await new Exasol().execute.call(ctx);

		const rows = (
			await connection.query(`SELECT COUNT(*) AS N FROM ${schema}.COMPETITIONS`)
		).getRows();
		expect(Number(rows[0].N)).toBe(2);
	});

	it('transaction mode rolls back all items when any item fails', async () => {
		// item 0 inserts a valid row; item 1 runs invalid SQL — both must be rolled back.
		const ctx = buildExecuteFunctions({
			container,
			items: [{ json: {} }, { json: {} }],
			params: {
				executionMode: 'transaction',
				query: perItem([
					`INSERT INTO ${schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
					'THIS IS INVALID SQL THAT WILL FAIL',
				]),
			},
		});

		await expect(new Exasol().execute.call(ctx)).rejects.toThrow();

		// The INSERT from item 0 must have been rolled back.
		const rows = (
			await connection.query(`SELECT COUNT(*) AS N FROM ${schema}.COMPETITIONS`)
		).getRows();
		expect(Number(rows[0].N)).toBe(0);
	});
});
