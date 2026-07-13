import { ExasolApi } from '../../credentials/ExasolApi.credentials';

describe('ExasolApi credential type', () => {
	const creds = new ExasolApi();

	it('has the correct internal name', () => {
		expect(creds.name).toBe('exasolApi');
	});

	it('requires host, port, user and password fields', () => {
		const names = creds.properties.map((p) => p.name);
		for (const field of ['host', 'port', 'user', 'password']) {
			expect(names).toContain(field);
		}
	});

	it('defaults port to 8563', () => {
		const portProp = creds.properties.find((p) => p.name === 'port');
		expect(portProp?.default).toBe(8563);
	});

	it('defaults resultSetMaxRows to 1000', () => {
		const resultSetMaxRowsProp = creds.properties.find((p) => p.name === 'resultSetMaxRows');
		expect(resultSetMaxRowsProp?.type).toBe('number');
		expect(resultSetMaxRowsProp?.default).toBe(1000);
	});
});
