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
