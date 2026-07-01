import type { ICredentialsDecrypted } from 'n8n-workflow';

import { ExasolDriver } from '@exasol/exasol-driver-ts';
import { Exasol } from '../../nodes/Exasol/Exasol.node';

jest.mock('@exasol/exasol-driver-ts');

const MockedExasolDriver = jest.mocked(ExasolDriver);

type MockDriver = {
	connect: jest.Mock;
	query: jest.Mock;
	close: jest.Mock;
};

describe('testExasolCredentials()', () => {
	let node: Exasol;
	let mockDriver: MockDriver;

	const credential = {
		id: '1',
		name: 'test',
		type: 'exasolApi',
		data: { host: 'db.example.com', port: 8563, user: 'admin', password: 'secret', schema: 'myschema' },
	} as ICredentialsDecrypted;

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

	it('returns OK when connection and query succeed', async () => {
		mockDriver.query.mockResolvedValue({ getRows: () => [] });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await node.testExasolCredentials.call({} as any, credential);

		expect(result).toEqual({ status: 'OK', message: 'Connection successful' });
	});

	it('returns Error when connect() rejects', async () => {
		mockDriver.connect.mockRejectedValue(new Error('Connection refused'));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await node.testExasolCredentials.call({} as any, credential);

		expect(result).toEqual({ status: 'Error', message: 'Connection refused' });
	});

	it('returns Error when query() rejects', async () => {
		mockDriver.query.mockRejectedValue(new Error('Auth failed'));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await node.testExasolCredentials.call({} as any, credential);

		expect(result).toEqual({ status: 'Error', message: 'Auth failed' });
	});

	it('always calls close(), even when connect() fails', async () => {
		mockDriver.connect.mockRejectedValue(new Error('fail'));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await node.testExasolCredentials.call({} as any, credential);

		expect(mockDriver.close).toHaveBeenCalledTimes(1);
	});

	it('does not throw when close() itself rejects', async () => {
		mockDriver.connect.mockRejectedValue(new Error('connect failed'));
		mockDriver.close.mockRejectedValue(new Error('close failed'));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(node.testExasolCredentials.call({} as any, credential)).resolves.toMatchObject({
			status: 'Error',
			message: 'connect failed',
		});
	});

	it('converts empty schema string to undefined when building the driver', async () => {
		const credNoSchema = {
			...credential,
			data: { ...credential.data, schema: '' },
		} as ICredentialsDecrypted;
		mockDriver.query.mockResolvedValue({ getRows: () => [] });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await node.testExasolCredentials.call({} as any, credNoSchema);

		expect(MockedExasolDriver).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ schema: undefined }),
		);
	});
});
