# Developer Guide

Onboarding for contributors to `n8n-nodes-exasol`, an npm package providing Exasol community nodes
for n8n. This is the human-facing companion to [CLAUDE.md](../CLAUDE.md), which is the terser,
agent-facing instruction file consulted by AI coding assistants working in this repo — the two
cover the same ground but at different levels of detail; if you change one, check whether the
other needs the same update. See also [community-vs-builtin.md](community-vs-builtin.md) for the
structural constraints of building a *community* node versus an n8n built-in one.

## Project overview

The node provides 9 operations split into two groups: 6 Database operations (Execute Query, Select
Rows, Insert, Update, Delete, Create or Update) and 3 read-only Schema Explorer operations (List
Schemas, List Tables, Describe Table), the latter aimed at AI agent database discovery. See the
[User Guide](user-guide.md) for what each operation does.

## Project structure

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
    insert/ update/ delete/   ← same layout
    upsert/
      description.ts
      execute.ts
      mergeBuilder.ts     ← MERGE SQL generator, upsert-only
    schemaExplorer/
      description.ts
      execute.ts          ← handles all 3 schema explorer operations
    shared/
      whereBuilder.ts     ← parameterized WHERE clause generator (Select, Update, Delete)
      resultMapper.ts     ← column-major ResultSet → row-object pivot (Execute Query, Select Rows)

tests/
  unit/
    *.test.ts
  integration/
    containerSetup.ts     ← starts exasol/docker-db via testcontainers
    nodeTestHelper.ts     ← mock IExecuteFunctions backed by real container credentials
    *.itest.ts
```

## Build & test commands

```bash
npm run build          # compile TypeScript → dist/
npm run build:watch    # watch mode
npm run dev            # n8n-node dev (live-reload node for local n8n testing)
npm run lint           # ESLint via n8n-node CLI
npm run lint:fix       # ESLint with auto-fix
npm test               # unit tests (Jest)
npm run itest          # integration tests (requires Docker, unless see below)
npm run test:all       # unit + integration
npm run release        # n8n-node release (maintainers only)
```

## Local development workflow

Link the package into a local n8n installation to try changes end-to-end:

```bash
npm install
npm run build
npm link
# In your n8n installation directory:
npm link n8n-nodes-exasol
```

### Testing against a local Docker DB

By default, `npm run itest` starts a fresh `exasol/docker-db` container via `testcontainers`
(`tests/integration/containerSetup.ts`), waiting for the `"All stages finished"` log line — about
2 minutes on a cold start. `.withReuse()` keeps the container alive across local runs so repeat
runs skip that wait, but the first run (or a run after Docker/the container was cleaned up) still
pays it.

If you already have an Exasol instance running locally — for example a long-lived `docker-db`
container you started yourself — you can skip the testcontainers startup entirely by setting both
`EXASOL_TEST_HOST` and `EXASOL_TEST_PORT`:

```bash
EXASOL_TEST_HOST=localhost EXASOL_TEST_PORT=8563 npm run itest
```

When both are set, `externalContainerFromEnv()` in `containerSetup.ts` short-circuits the Docker
startup and connects directly to that host/port instead. Two things to know before relying on
this:

- **User/password are not configurable via these env vars.** They stay hardcoded to the
  `exasol/docker-db` image's defaults (`sys`/`exasol`) regardless of which path is used — this only
  works against an instance provisioned with those credentials, not an arbitrary Exasol database.
- **CI never uses this path.** `.github/workflows/integration.yml` doesn't set either variable, so
  CI always spins up a fresh container end-to-end. The env-var override is a local-dev-only speed
  trick, not something to rely on for CI parity.

## Code documentation conventions

See [CLAUDE.md § Code documentation](../CLAUDE.md#code-documentation) for the full standard.
Summary: reviewers on this project may not know n8n's concepts, so inline docs explain
n8n-specific types/patterns where they first appear, and every function/class gets a JSDoc comment
— but comments should explain *why*, not restate what the code already says.

## Testing standards

See [CLAUDE.md § Testing standards](../CLAUDE.md#testing-standards) for the full standard.
Summary: aim for near-100% line/branch coverage; unit tests (`tests/unit/*.test.ts`) mock
`IExecuteFunctions` and never touch a real database; every operation needs both unit *and*
integration tests (`tests/integration/*.itest.ts`), the latter against a real Exasol instance via
the setup described above.

## Changelog process

See [CLAUDE.md § Changelog](../CLAUDE.md#changelog) for the exact file format. Summary: one file
per release under `doc/changes/` (`changes_X.Y.Z.md`), indexed from `doc/changes/changelog.md`,
newest first. Keep `## Features`/`## Bug Fixes` entries to one plain sentence each — see the
existing entries in `doc/changes/changes_0.1.0.md` for the target style.
