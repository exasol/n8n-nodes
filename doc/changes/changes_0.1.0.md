# n8n-nodes-exasol 0.1.0, released T.B.D.

Code name: Initial release

## Summary

Initial release of the Exasol n8n community node.

## Features

* #5: Refactored to the n8n operation model.
* #6: Added integration test infrastructure.
* #7: Implemented parameterized execute query.
* #17: Added Single Batch execution mode to Execute Query, sending all parameter-free items in one `executeBatch()` round-trip (falls back to Sequentially when parameters are present; any failure — including a result count that can't be mapped back to items, e.g. from a DDL statement — is reported as a failure of every item with the same message, never attributed to a specific one).
* #8: Added the Select Rows operation — a structured SELECT built from a schema/table picker, WHERE conditions (with AND/OR combination), sort rules, and a row limit. Introduces two pieces shared by later operations: `loadOptions` methods (`listSchemas`, `listTables`) backing the schema/table pickers, and `whereBuilder.ts`, which generates parameterized WHERE clauses from condition collections.
* #9: Added the Insert operation — batches every input item into a single `INSERT` statement (one `VALUES` tuple per item, one round-trip regardless of item count), returning `{ affectedRows: N }`. Supports both Auto-Map Input Data (columns taken from the first item's JSON keys) and Map Each Column Below (an explicit column/value collection, evaluated per item).
* #10: Added the Update operation — issues one `UPDATE` statement per input item, with the SET clause built the same way as Insert (Auto-Map Input Data or Map Each Column Below) and WHERE conditions reusing `whereBuilder.ts` from Select Rows. WHERE is required: an item with no conditions is rejected rather than updating every row in the table.
* #11: Added the Delete operation — issues one `DELETE` statement per input item, reusing the same WHERE condition UI as Select Rows and Update. WHERE is required: an item with no conditions is rejected rather than deleting every row in the table. Unlike Select Rows and Update, WHERE values are inlined as SQL literals rather than bound as `?` parameters, because Exasol's prepared DELETE only accepts parameterized conditions of the exact shape `<column> = ?` — anything else (a different operator, or an OR combinator) is rejected server-side.
* #12: Added the Upsert operation ("Create or Update") — batches every input item into a single generated `MERGE INTO ... USING (VALUES ...) ...` statement (one source row per item, one round-trip regardless of item count), via the new `mergeBuilder.ts`. Column mapping reuses Insert's Auto-Map Input Data / Map Each Column Below pattern; a new "Conflict Columns" field picks which mapped columns identify an existing row, forming the `ON` clause, while every other mapped column is set on a match. Like Delete, row values are inlined as SQL literals rather than bound as `?` parameters — Exasol's prepared-statement support rejects a `VALUES(?, ?)` placeholder list used as a MERGE source. A row with a NULL Conflict Column value is rejected with a clear error rather than silently inserted as a duplicate on every run — Exasol's MERGE `ON` clause only permits a plain `=`, so a NULL-safe match can't be expressed at the SQL level. `quoteLiteral()` (shared with Delete's WHERE clause) now also renders a `Date` value as a proper Exasol timestamp literal instead of falling into its generic stringify fallback.

## Dependency Updates

### Compile Dependency Updates

* Added `@exasol/exasol-driver-ts:^0.4.0`
* Added `ws:^8.21.0`

### Development Dependency Updates

* Added `@n8n/node-cli:*`
* Added `@types/jest:^30.0.0`
* Added `@types/ws:^8.18.1`
* Added `eslint:9.39.4`
* Added `jest:^30.0.0`
* Added `n8n-workflow:>=2.0.0`
* Added `prettier:3.8.3`
* Added `release-it:^20.2.1`
* Added `ts-jest:^29.4.0`
* Added `typescript:5.9.3`
