import { buildMergeQuery } from '../../nodes/Exasol/operations/upsert/mergeBuilder';

describe('buildMergeQuery()', () => {
	it('builds a MERGE for a single conflict column and a single row', () => {
		const query = buildMergeQuery('MY_SCHEMA', 'ITEMS', ['ID', 'NAME'], ['ID'], [[1, 'a']]);

		expect(query).toBe(
			'MERGE INTO "MY_SCHEMA"."ITEMS" target\n' +
				'USING (\n' +
				"  VALUES (1, 'a')\n" +
				') src("ID", "NAME")\n' +
				'ON target."ID" = src."ID"\n' +
				'WHEN MATCHED THEN\n' +
				'  UPDATE SET target."NAME" = src."NAME"\n' +
				'WHEN NOT MATCHED THEN\n' +
				'  INSERT ("ID", "NAME") VALUES (src."ID", src."NAME")',
		);
	});

	it('batches multiple rows into one VALUES list, in the same order, each inlined as a literal', () => {
		const query = buildMergeQuery(
			'S',
			'T',
			['ID', 'NAME'],
			['ID'],
			[
				[1, 'a'],
				[2, 'b'],
				[3, 'c'],
			],
		);

		expect(query).toContain("VALUES (1, 'a'),\n         (2, 'b'),\n         (3, 'c')");
	});

	it('ANDs multiple conflict columns together in the ON clause', () => {
		const query = buildMergeQuery(
			'S',
			'T',
			['TENANT_ID', 'ID', 'NAME'],
			['TENANT_ID', 'ID'],
			[[1, 2, 'a']],
		);

		expect(query).toContain('ON target."TENANT_ID" = src."TENANT_ID" AND target."ID" = src."ID"');
	});

	it('sets every non-conflict column on a match, in column order', () => {
		const query = buildMergeQuery('S', 'T', ['ID', 'NAME', 'ALTITUDE'], ['ID'], [[1, 'a', 100]]);

		expect(query).toContain(
			'UPDATE SET target."NAME" = src."NAME", target."ALTITUDE" = src."ALTITUDE"',
		);
	});

	it('omits WHEN MATCHED entirely when every mapped column is a conflict column', () => {
		const query = buildMergeQuery('S', 'T', ['ID'], ['ID'], [[1]]);

		expect(query).not.toContain('WHEN MATCHED');
		expect(query).toContain('WHEN NOT MATCHED THEN\n  INSERT ("ID") VALUES (src."ID")');
	});

	it('inserts every mapped column, including conflict columns, on no match', () => {
		const query = buildMergeQuery('S', 'T', ['ID', 'NAME'], ['ID'], [[1, 'a']]);

		expect(query).toContain('INSERT ("ID", "NAME") VALUES (src."ID", src."NAME")');
	});

	it('quotes identifiers, escaping embedded double quotes', () => {
		const query = buildMergeQuery('S', 'WEIRD"TABLE', ['WEIRD"COL'], ['WEIRD"COL'], [[1]]);

		expect(query).toContain('"WEIRD""TABLE"');
		expect(query).toContain('"WEIRD""COL"');
	});

	// ── Row value literals ───────────────────────────────────────────────────────
	// Values are inlined via quoteLiteral() (see whereBuilder.test.ts for that helper's own
	// coverage) rather than bound as `?` parameters — Exasol's prepare() rejects a MERGE whose
	// VALUES-derived source uses placeholders, the same restriction Delete already works around.

	it('inlines a null value as the NULL literal', () => {
		const query = buildMergeQuery('S', 'T', ['ID', 'NAME'], ['ID'], [[1, null]]);

		expect(query).toContain('VALUES (1, NULL)');
	});

	it('escapes an embedded single quote in a string value', () => {
		const query = buildMergeQuery('S', 'T', ['ID', 'NAME'], ['ID'], [[1, "O'Brien"]]);

		expect(query).toContain("VALUES (1, 'O''Brien')");
	});

	// A JS Date (e.g. from an upstream node's JSON, or a ={{ new Date() }} expression) must render
	// as an Exasol timestamp literal, not quoteLiteral()'s generic String(value) stringification —
	// see whereBuilder.test.ts's quoteLiteral() suite for the full behavior this delegates to.
	it('inlines a Date value as an Exasol timestamp literal', () => {
		const query = buildMergeQuery(
			'S',
			'T',
			['ID', 'CREATED_AT'],
			['ID'],
			[[1, new Date('2024-01-15T10:30:00.123Z')]],
		);

		expect(query).toContain("VALUES (1, '2024-01-15 10:30:00.123')");
	});

	// ── Validation ───────────────────────────────────────────────────────────────

	it('rejects an empty conflict column list', () => {
		expect(() => buildMergeQuery('S', 'T', ['ID', 'NAME'], [], [[1, 'a']])).toThrow(
			/At least one Conflict Column is required/,
		);
	});

	it('rejects a blank conflict column name', () => {
		expect(() => buildMergeQuery('S', 'T', ['ID', 'NAME'], [''], [[1, 'a']])).toThrow(
			/Conflict Column names must be non-empty strings/,
		);
	});

	it('rejects a whitespace-only conflict column name', () => {
		expect(() => buildMergeQuery('S', 'T', ['ID', 'NAME'], ['   '], [[1, 'a']])).toThrow(
			/Conflict Column names must be non-empty strings/,
		);
	});

	it('rejects a non-string conflict column entry instead of crashing on .trim()', () => {
		expect(() => buildMergeQuery('S', 'T', ['ID', 'NAME'], [42], [[1, 'a']])).toThrow(
			/Conflict Column names must be non-empty strings/,
		);
	});

	it('rejects a conflict column not present in the mapped columns', () => {
		expect(() => buildMergeQuery('S', 'T', ['ID', 'NAME'], ['NOPE'], [[1, 'a']])).toThrow(
			/Conflict Column\(s\) not present in the mapped columns \(ID, NAME\): NOPE/,
		);
	});

	// ── NULL conflict-column values ────────────────────────────────────────────────
	// Exasol's MERGE ON clause only permits a plain "=" (per Exasol's own docs: "In the ON
	// condition, only equivalence conditions (=) are permitted") — no OR, no IS NULL/COALESCE/NVL
	// wrapping, so a NULL-safe ON clause can't be expressed at the SQL level. A row with a NULL
	// conflict-column value is rejected outright instead: silently letting it through would insert
	// a fresh duplicate on every repeated upsert, since NULL = NULL is UNKNOWN, not TRUE.

	it('rejects a row with a null value in a conflict column', () => {
		expect(() =>
			buildMergeQuery('S', 'T', ['ID', 'NAME'], ['ID'], [[null, 'a']]),
		).toThrow(/Row 0 has no value for Conflict Column "ID"/);
	});

	it('rejects a row with an undefined value in a conflict column', () => {
		expect(() =>
			buildMergeQuery('S', 'T', ['ID', 'NAME'], ['ID'], [[undefined, 'a']]),
		).toThrow(/Row 0 has no value for Conflict Column "ID"/);
	});

	it('identifies which row and conflict column failed when several rows are batched', () => {
		expect(() =>
			buildMergeQuery(
				'S',
				'T',
				['ID', 'REGION', 'NAME'],
				['ID', 'REGION'],
				[
					[1, 'eu', 'a'],
					[2, null, 'b'],
				],
			),
		).toThrow(/Row 1 has no value for Conflict Column "REGION"/);
	});

	it('does not reject a null value in a non-conflict column', () => {
		expect(() =>
			buildMergeQuery('S', 'T', ['ID', 'NAME'], ['ID'], [[1, null]]),
		).not.toThrow();
	});
});
