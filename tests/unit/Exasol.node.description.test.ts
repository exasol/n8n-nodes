import type { INodePropertyOptions } from 'n8n-workflow';

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

	it('has an operation dropdown listing executeQuery', () => {
		const operationProp = node.description.properties.find((p) => p.name === 'operation');
		expect(operationProp).toBeDefined();
		expect(operationProp?.type).toBe('options');
		const values = (operationProp?.options as INodePropertyOptions[]).map((o) => o.value);
		expect(values).toContain('executeQuery');
	});

	it('exposes a SQL query parameter', () => {
		const names = node.description.properties.map((p) => p.name);
		expect(names).toContain('query');
	});
});
