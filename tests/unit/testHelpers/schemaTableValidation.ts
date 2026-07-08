import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * Every operation that takes a Schema/Table pair validates both through the shared
 * requireNonEmpty() helper (see validation.test.ts for unit coverage of that helper itself).
 * This registers the four `it(...)` cases that re-appeared, nearly verbatim, in each
 * operation's own test file: they check that the operation's execute() actually wires
 * requireNonEmpty in, propagates its NodeOperationError untouched, honours continueOnFail,
 * and quotes the trimmed value rather than the raw one in the generated SQL.
 *
 * Call this directly inside a describe() block, alongside the file's own tests.
 *
 * @param config.execute - runs the operation under test, mirroring `node.execute.call(ctx)`
 * @param config.makeContext - the test file's own context builder; only schema/table/continueOnFail are overridden here
 * @param config.assertNotExecuted - asserts none of the operation's driver calls ran after an empty-Schema failure
 * @param config.assertTrimmedSqlExecuted - asserts the trimmed Schema/Table were quoted into the SQL issued for a padded-whitespace context
 */
export function itValidatesSchemaAndTable(config: {
	execute: (ctx: IExecuteFunctions) => Promise<INodeExecutionData[][]>;
	makeContext: (opts: {
		schema?: string;
		table?: string;
		continueOnFail?: boolean;
	}) => IExecuteFunctions;
	assertNotExecuted: () => void;
	assertTrimmedSqlExecuted: () => void;
}) {
	const { execute, makeContext, assertNotExecuted, assertTrimmedSqlExecuted } = config;

	it('throws NodeOperationError for an empty Schema without wrapping it a second time', async () => {
		const thrown = await execute(makeContext({ schema: '' })).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Schema must not be empty');
		assertNotExecuted();
	});

	it('throws NodeOperationError for an empty Table', async () => {
		const thrown = await execute(makeContext({ table: '' })).catch((e) => e);

		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect((thrown as NodeOperationError).message).toContain('Table must not be empty');
	});

	it('trims surrounding whitespace from Schema and Table before quoting them', async () => {
		await execute(makeContext({ schema: '  MY_SCHEMA  ', table: '  MY_TABLE  ' }));

		assertTrimmedSqlExecuted();
	});

	it('stores an empty-Schema error in json when continueOnFail is true', async () => {
		const [[item]] = await execute(makeContext({ schema: '', continueOnFail: true }));

		expect(item.json).toMatchObject({ error: expect.stringContaining('Schema must not be empty') });
	});
}
