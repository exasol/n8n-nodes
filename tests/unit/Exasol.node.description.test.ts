import { Exasol } from '../../nodes/Exasol/Exasol.node';

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
