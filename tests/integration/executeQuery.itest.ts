import { NodeOperationError } from 'n8n-workflow';

import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { useExasolTestFixture } from './fixtures';
import { buildExecuteFunctions, perItem } from './nodeTestHelper';
import { setupTestData } from './testData';

describe('Execute Query operation', () => {
	const fixture = useExasolTestFixture({ setupData: setupTestData });

	// ── Basic execution ─────────────────────────────────────────────────────────

	it('executes SELECT 1 and returns a row', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			params: { query: 'SELECT 1 AS N' },
		});
		const [[item]] = await new Exasol().execute.call(ctx);

		expect(Number(item.json.N)).toBe(1);
	});

	it('raw-path DML returns { affectedRows: N }', async () => {
		// No parameters → raw path; INSERT is non-SELECT → driver.query(..., 'raw') → rowCount.
		// COMPETITIONS references SKI_RUN via FK; (1000, 'Christine') is a valid pair.
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			params: {
				query: `INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
			},
		});
		const [[item]] = await new Exasol().execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 1 });
	});

	// ── Parameterized path ──────────────────────────────────────────────────────

	it('parameterized INSERT returns { affectedRows: 1 }', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			params: {
				query: `INSERT INTO ${fixture.schema}.COMPETITIONS VALUES (?, ?, ?, ?)`,
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
			container: fixture.container,
			params: {
				query: `INSERT INTO ${fixture.schema}.COMPETITIONS VALUES (?, ?, ?, ?)`,
				parameters: {
					values: [{ value: 'FIS WC' }, { value: 2024 }, { value: 1000 }, { value: 'Christine' }],
				},
			},
		});
		await new Exasol().execute.call(insertCtx);

		// Verify the row is actually in the database via a direct connection query.
		const rows = (
			await fixture.connection.query(
				`SELECT SERIES, SEASON FROM ${fixture.schema}.COMPETITIONS ORDER BY SERIES`,
			)
		).getRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].SERIES).toBe('FIS WC');
		expect(Number(rows[0].SEASON)).toBe(2024);
	});

	it('parameterized SELECT filters rows with a bound value', async () => {
		// SKI_RESORT is pre-populated by setupTestData with three resorts; select one by ID.
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			params: {
				query: `SELECT RESORT_ID, RESORT_NAME FROM ${fixture.schema}.SKI_RESORT WHERE RESORT_ID = ?`,
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
			container: fixture.container,
			items: [{ json: {} }, { json: {} }],
			params: {
				executionMode: 'transaction',
				query: perItem([
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Allamande')`,
				]),
			},
		});
		await new Exasol().execute.call(ctx);

		const rows = (
			await fixture.connection.query(`SELECT COUNT(*) AS N FROM ${fixture.schema}.COMPETITIONS`)
		).getRows();
		expect(Number(rows[0].N)).toBe(2);
	});

	it('transaction mode rolls back all items when any item fails', async () => {
		// item 0 inserts a valid row; item 1 runs invalid SQL — both must be rolled back.
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			items: [{ json: {} }, { json: {} }],
			params: {
				executionMode: 'transaction',
				query: perItem([
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
					'THIS IS INVALID SQL THAT WILL FAIL',
				]),
			},
		});

		await expect(new Exasol().execute.call(ctx)).rejects.toThrow();

		// The INSERT from item 0 must have been rolled back.
		const rows = (
			await fixture.connection.query(`SELECT COUNT(*) AS N FROM ${fixture.schema}.COMPETITIONS`)
		).getRows();
		expect(Number(rows[0].N)).toBe(0);
	});

	// ── Single Batch mode ───────────────────────────────────────────────────────

	it('single mode sends a batch of 3 INSERTs and returns 3 affectedRows results', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			items: [{ json: {} }, { json: {} }, { json: {} }],
			params: {
				executionMode: 'single',
				query: perItem([
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Allamande')`,
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1001, 'Chanrossa')`,
				]),
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([
			{ json: { affectedRows: 1 }, pairedItem: { item: 0 } },
			{ json: { affectedRows: 1 }, pairedItem: { item: 1 } },
			{ json: { affectedRows: 1 }, pairedItem: { item: 2 } },
		]);

		const rows = (
			await fixture.connection.query(`SELECT COUNT(*) AS N FROM ${fixture.schema}.COMPETITIONS`)
		).getRows();
		expect(Number(rows[0].N)).toBe(3);
	});

	it('single mode surfaces one batch-wide error (attributed to item 0) when the batch contains invalid SQL', async () => {
		// item 0 would insert a valid row; item 1 runs invalid SQL. The whole batch
		// fails as one call — there is no per-item retry, so item 0's insert never
		// happens either, and the error can't be attributed to the real culprit (item 1).
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			items: [{ json: {} }, { json: {} }],
			params: {
				executionMode: 'single',
				query: perItem([
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
					'THIS IS INVALID SQL THAT WILL FAIL',
				]),
			},
		});

		const thrown = await new Exasol().execute.call(ctx).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).context?.itemIndex).toBe(0);

		const rows = (
			await fixture.connection.query(`SELECT COUNT(*) AS N FROM ${fixture.schema}.COMPETITIONS`)
		).getRows();
		expect(Number(rows[0].N)).toBe(0);
	});

	it('single mode falls back to per-item execution when an item uses Parameters', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			params: {
				executionMode: 'single',
				query: `INSERT INTO ${fixture.schema}.COMPETITIONS VALUES (?, ?, ?, ?)`,
				parameters: {
					values: [{ value: 'FIS WC' }, { value: 2024 }, { value: 1000 }, { value: 'Christine' }],
				},
			},
		});
		const [[item]] = await new Exasol().execute.call(ctx);

		expect(item.json).toEqual({ affectedRows: 1 });
	});

	it('single mode returns one error item per input item (same message) when continueOnFail is true and the batch fails', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			items: [{ json: {} }, { json: {} }],
			params: {
				executionMode: 'single',
				query: perItem([
					`INSERT INTO ${fixture.schema}.COMPETITIONS VALUES ('FIS WC', 2024, 1000, 'Christine')`,
					'THIS IS INVALID SQL THAT WILL FAIL',
				]),
			},
			continueOnFail: true,
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result[0].json).toMatchObject({ error: expect.any(String) });
		expect(result[1].json).toEqual(result[0].json);
		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('single mode successfully batches a DDL statement together with a DML statement', async () => {
		// Confirms against a real Exasol instance that a CREATE TABLE statement
		// contributes exactly one entry to a batch's results array — same as any DML
		// statement — so the item-count guard in executeBatched does not spuriously
		// reject a batch mixing DDL and DML.
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			items: [{ json: {} }, { json: {} }],
			params: {
				executionMode: 'single',
				query: perItem([
					`CREATE TABLE ${fixture.schema}.TMP_SINGLE_BATCH (ID INTEGER)`,
					`INSERT INTO ${fixture.schema}.TMP_SINGLE_BATCH VALUES (1)`,
				]),
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toEqual([
			{ json: { affectedRows: 0 }, pairedItem: { item: 0 } },
			{ json: { affectedRows: 1 }, pairedItem: { item: 1 } },
		]);

		const rows = (
			await fixture.connection.query(
				`SELECT COUNT(*) AS N FROM ${fixture.schema}.TMP_SINGLE_BATCH`,
			)
		).getRows();
		expect(Number(rows[0].N)).toBe(1);
	});
});
