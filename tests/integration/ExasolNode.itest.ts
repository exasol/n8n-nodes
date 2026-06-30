import { Exasol } from '../../nodes/Exasol/Exasol.node';
import { ExasolApi } from '../../credentials/ExasolApi.credentials';

describe('Exasol node description', () => {
	const node = new Exasol();

	it('has the correct internal name', () => {
		expect(node.description.name).toBe('exasol');
	});

	it('has the correct display name', () => {
		expect(node.description.displayName).toBe('Exasol');
	});

	it('requires exasolApi credentials', () => {
		expect(node.description.credentials).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'exasolApi', required: true }),
			]),
		);
	});

	it('exposes a SQL query parameter', () => {
		const names = node.description.properties.map((p) => p.name);
		expect(names).toContain('query');
	});
});

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

	it('enables TLS encryption by default', () => {
		const encProp = creds.properties.find((p) => p.name === 'encryption');
		expect(encProp?.default).toBe(true);
	});
});
