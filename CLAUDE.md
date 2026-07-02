# n8n-nodes-exasol — Development Guide

## Project overview

npm package `n8n-nodes-exasol` — Exasol community nodes for n8n.

The node provides 13 operations split into two groups:

**Database (6):** Execute Query, Select Rows, Insert, Update, Delete, Upsert  
**Schema Explorer (7, read-only, for AI agent use):** List Schemas, List Tables, Describe Table, List Functions, Describe Function, List UDFs, Describe UDF

Design document: https://claude.ai/code/artifact/972130dc-8cc5-4f62-877f-10ac5b93ec43

## Architecture

### Connection lifecycle

One connection opens at the start of `execute()`, shared across all input items, closed in a `finally` block. This is the per-execution (MySQL) pattern — the Postgres approach of cross-invocation pooling requires `ConnectionPoolManager`, which is unavailable to community nodes.

### Driver

`@exasol/exasol-driver-ts` over WebSocket. The `ws` package provides the WebSocket factory, cast via `as unknown as ExaWebsocket`.

### Write operations

Exasol has no `RETURNING` clause. Insert, Update, Delete, and Upsert all return `{ affectedRows: N }` only.

### Upsert

Exasol has no `INSERT ON CONFLICT`. Upsert generates a `MERGE INTO … USING (VALUES …)` statement via `mergeBuilder.ts`.

### File structure

```
credentials/
  ExasolApi.credentials.ts

nodes/Exasol/
  Exasol.node.ts          ← main node class; operation router + loadOptions
  Exasol.node.json
  exasol.svg
  exasol.dark.svg

  operations/
    index.ts              ← barrel; re-exports all operation descriptions + execute fns
    executeQuery/
      description.ts      ← INodeProperties[] for this operation
      execute.ts          ← execute function for this operation
    selectRows/
      description.ts
      execute.ts
    insert/ update/ delete/ upsert/   ← same layout
    schemaExplorer/
      description.ts
      execute.ts          ← handles all 7 schema explorer operations
    shared/
      whereBuilder.ts     ← parameterized WHERE clause generator (Select, Update, Delete)
      mergeBuilder.ts     ← MERGE SQL generator (Upsert)

tests/
  unit/
    *.test.ts
  integration/
    containerSetup.ts     ← starts exasol/docker-db via testcontainers
    nodeTestHelper.ts     ← mock IExecuteFunctions backed by real container credentials
    *.itest.ts
```

## Commands

```bash
npm run build          # compile TypeScript → dist/
npm run build:watch    # watch mode
npm run lint           # ESLint via n8n-node CLI
npm run lint:fix       # ESLint with auto-fix
npm test               # unit tests (Jest)
npm run itest          # integration tests (requires Docker)
npm run test:all       # unit + integration
```

## Testing standards

### Coverage

Aim for near 100% line and branch coverage. Do not skip coverage for branches that are reachable; only exclude truly unreachable code with a `/* istanbul ignore next */` comment and a brief explanation.

### Unit tests

- Location: `tests/unit/*.test.ts`
- Mock `IExecuteFunctions` — never talk to a real database.
- Every operation gets its own test file covering: happy path, edge cases, `continueOnFail` behavior, and error propagation.
- Shared helpers (`whereBuilder.ts`, `mergeBuilder.ts`) are unit-tested independently of the operations that use them.

### Integration tests

- Location: `tests/integration/*.itest.ts`
- **Every new operation must have integration tests.** Unit tests alone are not sufficient.
- Use `testcontainers` to start `exasol/docker-db:latest` (ports 8563/2580, privileged mode, `.withReuse()` for local dev speed). Wait strategy: `"All stages finished"` log message (~2 min startup).
- `containerSetup.ts` manages the container lifecycle (`beforeAll` / `afterAll`).
- `nodeTestHelper.ts` creates a mock `IExecuteFunctions` with real container credentials.
- Each suite creates a fresh schema in `beforeEach` and drops it in `afterEach` — tests must be fully isolated.
- Integration tests run in a separate Jest project (`itest`) and a separate CI job (`.github/workflows/integration.yml`).

```typescript
// Typical integration test structure
describe('Insert operation', () => {
  let schema: string;

  beforeEach(async () => {
    schema = await createSchema(connection);
    await connection.query(`CREATE TABLE ${schema}.ITEMS (ID INTEGER, NAME VARCHAR(100))`);
  });

  afterEach(async () => {
    await dropSchema(connection, schema);
  });

  it('inserts a single row', async () => {
    const ctx = buildExecuteFunctions({ schema, table: 'ITEMS', /* ... */ });
    const result = await executeInsert.call(ctx);
    expect(result[0][0].json).toEqual({ affectedRows: 1 });
  });
});
```

## Code documentation

Code reviewers on this project may not be familiar with n8n concepts. Write inline documentation so that someone reading the code without n8n knowledge can follow what is happening. Specifically:

- Explain n8n-specific types and patterns where they first appear in a file. For example: what `IExecuteFunctions` is, why `getNodeParameter` takes an item index, what `continueOnFail` does, why `loadOptions` returns `INodePropertyOptions[]`.
- Explain the `INodeProperties` fields in `description.ts` files that are non-obvious (e.g., `displayOptions.show`, `typeOptions.loadOptionsMethod`, fixed-collection structure).
- Use JSDoc on all exported functions and classes.

```typescript
/**
 * Builds a parameterized WHERE clause from the "where" fixed-collection parameter.
 * A fixed-collection in n8n is a repeatable group of fields — here each entry is
 * { column, operator, value }. Returns an empty clause when no conditions are set.
 *
 * @returns clause — SQL fragment starting with "WHERE", or empty string
 * @returns params — bound values in the same order as the ? placeholders
 */
export function buildWhereClause(conditions: WhereCondition[]): WhereResult { … }
```

Do not add comments that just restate what the code already says. Only comment when the *why* is non-obvious, or when an n8n concept needs a brief explanation for context.

## Changelog

Keep a changelog under `doc/changes/`. Follow the same format as `exasol-driver-ts`:

- `doc/changes/changelog.md` — index listing all versions, newest first
- `doc/changes/changes_X.Y.Z.md` — one file per release

### Per-release file format

```markdown
# n8n-nodes-exasol X.Y.Z, released YYYY-MM-DD

Code name: <short descriptor>

## Summary

One paragraph describing what changed.

## Features

* Short description of each new feature

## Bug Fixes

* Short description of each fix

## Dependency Updates

### Compile Dependency Updates

* Updated `package:^old` to `^new`

### Development Dependency Updates

* Updated `package:^old` to `^new`
```

Omit sections that do not apply to a given release.

### changelog.md index format

```markdown
# Changes

* [X.Y.Z](changes_X.Y.Z.md)
* [X.Y.Z-1](changes_X.Y.Z-1.md)
```

## Git

New files created by the Write tool are automatically staged via a PostToolUse hook in `.claude/settings.json`. If you create files with Bash (e.g., `mkdir` + `touch`), stage them manually with `git add`.
