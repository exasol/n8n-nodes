import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { ExasolDriver } from '@exasol/exasol-driver-ts';
import { Exasol } from '../../nodes/Exasol/Exasol.node';

jest.mock('@exasol/exasol-driver-ts');

const MockedExasolDriver = jest.mocked(ExasolDriver);

type MockDriver = {
	connect: jest.Mock;
	query: jest.Mock;
	close: jest.Mock;
};

describe('execute()', () => {
	let node: Exasol;
	let mockDriver: MockDriver;

	beforeEach(() => {
		node = new Exasol();
		mockDriver = {
			connect: jest.fn().mockResolvedValue(undefined),
			query: jest.fn(),
			close: jest.fn().mockResolvedValue(undefined),
		};
		MockedExasolDriver.mockImplementation(() => mockDriver as unknown as ExasolDriver);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	function makeContext(opts: {
		items?: INodeExecutionData[];
		query?: string;
		continueOnFail?: boolean;
	} = {}): IExecuteFunctions {
		return {
			getCredentials: jest.fn().mockResolvedValue({
				host: 'localhost', port: 8563, user: 'u', password: 'p', schema: '',
			}),
			getInputData: jest.fn().mockReturnValue(opts.items ?? [{ json: {} }]),
			getNodeParameter: jest.fn().mockReturnValue(opts.query ?? 'SELECT 1'),
			continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
			getNode: jest.fn().mockReturnValue({ name: 'Exasol', type: 'exasol' }),
		} as unknown as IExecuteFunctions;
	}

	it('maps query rows to INodeExecutionData items', async () => {
		const rows = [{ id: 1 }, { id: 2 }];
		mockDriver.query.mockResolvedValue({ getRows: () => rows });

		const [result] = await node.execute.call(makeContext());

		expect(result).toHaveLength(2);
		expect(result[0].json).toEqual({ id: 1 });
		expect(result[1].json).toEqual({ id: 2 });
	});

	it('sets pairedItem.item to the input item index', async () => {
		mockDriver.query
			.mockResolvedValueOnce({ getRows: () => [{ a: 1 }] })
			.mockResolvedValueOnce({ getRows: () => [{ b: 2 }] });

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }] });
		const [result] = await node.execute.call(ctx);

		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('returns an empty array when the query yields no rows', async () => {
		mockDriver.query.mockResolvedValue({ getRows: () => [] });

		const [result] = await node.execute.call(makeContext());

		expect(result).toHaveLength(0);
	});

	it('concatenates rows from multiple input items', async () => {
		mockDriver.query
			.mockResolvedValueOnce({ getRows: () => [{ a: 1 }] })
			.mockResolvedValueOnce({ getRows: () => [{ b: 2 }] });

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }] });
		const [result] = await node.execute.call(ctx);

		expect(result).toHaveLength(2);
		expect(result[0].json).toEqual({ a: 1 });
		expect(result[1].json).toEqual({ b: 2 });
	});

	it('closes the driver after a successful run', async () => {
		mockDriver.query.mockResolvedValue({ getRows: () => [] });

		await node.execute.call(makeContext());

		expect(mockDriver.close).toHaveBeenCalledTimes(1);
	});

	it('closes the driver even when a query fails', async () => {
		mockDriver.query.mockRejectedValue(new Error('boom'));

		await expect(node.execute.call(makeContext())).rejects.toThrow();

		expect(mockDriver.close).toHaveBeenCalledTimes(1);
	});

	it('stores error in json when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad sql'));

		const ctx = makeContext({ continueOnFail: true });
		const [[item]] = await node.execute.call(ctx);

		expect(item.json).toEqual({ error: 'bad sql' });
	});

	it('sets pairedItem on error output when continueOnFail is true', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad sql'));

		const ctx = makeContext({ items: [{ json: {} }, { json: {} }], continueOnFail: true });
		const [result] = await node.execute.call(ctx);

		expect(result[0].pairedItem).toEqual({ item: 0 });
		expect(result[1].pairedItem).toEqual({ item: 1 });
	});

	it('throws NodeOperationError when continueOnFail is false', async () => {
		mockDriver.query.mockRejectedValue(new Error('bad sql'));

		await expect(
			node.execute.call(makeContext({ continueOnFail: false })),
		).rejects.toBeInstanceOf(NodeOperationError);
	});
});
