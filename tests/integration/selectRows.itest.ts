import { NodeOperationError } from 'n8n-workflow';

import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { useExasolTestFixture } from './fixtures';
import { buildExecuteFunctions } from './nodeTestHelper';
import { setupTestData } from './testData';

describe('Select Rows operation', () => {
	const fixture = useExasolTestFixture({ setupData: setupTestData });

	// setupTestData seeds SKI_RESORT with three resorts:
	//   (1000, 'Val Thorens', 'France', 2300)
	//   (1001, 'Courchevel', 'France', 1850)
	//   (1002, 'Kitzbuhel', 'Austria', 762)

	it('selects all rows with no WHERE, sort, or limit', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: { schema: fixture.schema, table: 'SKI_RESORT' },
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(3);
	});

	it('filters rows with a WHERE = condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				where: { conditions: [{ column: 'RESORT_ID', operator: 'equals', value: 1000 }] },
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(1);
		expect(result[0].json.RESORT_NAME).toBe('Val Thorens');
	});

	it('filters rows with a WHERE LIKE condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				where: { conditions: [{ column: 'COUNTRY', operator: 'like', value: 'Fra%' }] },
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result.map((item) => item.json.COUNTRY)).toEqual(['France', 'France']);
	});

	it('filters rows with a WHERE NOT LIKE condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				where: { conditions: [{ column: 'COUNTRY', operator: 'notLike', value: 'Fra%' }] },
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(1);
		expect(result[0].json.COUNTRY).toBe('Austria');
	});

	it('filters rows with a WHERE REGEXP LIKE condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				where: { conditions: [{ column: 'COUNTRY', operator: 'regexpLike', value: '^Fra.*' }] },
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result.map((item) => item.json.COUNTRY)).toEqual(['France', 'France']);
	});

	it('filters rows with a WHERE NOT REGEXP LIKE condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				where: {
					conditions: [{ column: 'COUNTRY', operator: 'notRegexpLike', value: '^Fra.*' }],
				},
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(1);
		expect(result[0].json.COUNTRY).toBe('Austria');
	});

	it('filters rows with an IS NULL condition', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				where: { conditions: [{ column: 'RESORT_NAME', operator: 'isNull' }] },
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(0);
	});

	it('combines multiple WHERE conditions with OR', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				combineConditions: 'OR',
				where: {
					conditions: [
						{ column: 'RESORT_ID', operator: 'equals', value: 1000 },
						{ column: 'RESORT_ID', operator: 'equals', value: 1002 },
					],
				},
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(2);
	});

	it('applies Limit when Return All is false', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: { schema: fixture.schema, table: 'SKI_RESORT', returnAll: false, limit: 1 },
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result).toHaveLength(1);
	});

	it('orders results according to ORDER BY', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: {
				schema: fixture.schema,
				table: 'SKI_RESORT',
				sort: { rules: [{ column: 'ALTITUDE', direction: 'ASC' }] },
			},
		});
		const [result] = await new Exasol().execute.call(ctx);

		expect(result.map((item) => Number(item.json.RESORT_ID))).toEqual([1002, 1001, 1000]);
	});

	it('throws NodeOperationError for an unknown table', async () => {
		const ctx = buildExecuteFunctions({
			container: fixture.container,
			operation: 'selectRows',
			params: { schema: fixture.schema, table: 'NO_SUCH_TABLE' },
		});

		await expect(new Exasol().execute.call(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});
});
