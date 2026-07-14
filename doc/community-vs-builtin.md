# Community node vs. built-in node gaps

n8n ships a set of database nodes (Postgres, MySQL, and others) built directly into n8n core.
This package is a *community* node — installed separately via npm — which comes with a few
structural gaps against what a built-in node can do. None of these are bugs; they're constraints
of the community node API surface. This doc records them so they aren't rediscovered by surprise.

## Connection pool access

This node opens one connection at the start of `execute()`, shares it across all input items, and
closes it in a `finally` block — one connect/disconnect cycle per node execution (see
[Developer Guide](developer-guide.md) for the architecture). Built-in database nodes can instead
maintain a connection pool across invocations via `ConnectionPoolManager`, an API internal to
n8n core that isn't exposed to community nodes. The trade-off: this node's per-execution model
can't leak state between workflow runs (a fresh connection every time), at the cost of paying a
WebSocket handshake on every execution rather than reusing a warm connection.

## Internal test helpers

Built-in nodes' test suites can lean on n8n-core's own internal testing utilities (workflow
execution harnesses, credential mocking that's already wired into the monorepo). As a package
external to n8n core, this project instead hand-builds its own mock harness —
`tests/integration/nodeTestHelper.ts` builds a mock `IExecuteFunctions` backed by a real database
connection to a test container. This means the project owns and maintains its entire test-harness
surface, which is more upfront work, but also isn't coupled to n8n-core's internal APIs, which are
not a stable public contract.

## Live resourceMapper

Built-in database nodes typically use n8n's `resourceMapper` UI component for column mapping: a
single widget that introspects the live table schema and presents type-aware inputs per column,
refreshed as the user changes the target table. This node instead uses static `loadOptions`
dropdowns (`listSchemas`, `listTables` in `Exasol.node.ts`) for the schema/table pickers, plus a
manual fixed-collection ("Map Each Column Below") for column values on Insert/Update/Upsert. The
end result is functionally similar — pick a table, map columns — but each field is populated and
refreshed independently rather than presented as one live, schema-aware mapping widget.

## npm vs. built-in catalog

This node is installed via `npm install n8n-nodes-exasol` (or n8n's Community Nodes UI) and
version-pinned by whoever administers the n8n instance. It does not ship with n8n core and does
not receive automatic updates when n8n itself is upgraded — a workflow author needs to explicitly
bump the package version and re-test. Built-in nodes, by contrast, are bundled into every n8n
release and upgrade in lockstep with the platform, with no separate install/update step. Practical
implication: check this package's [changelog](changes/changelog.md) before bumping its version,
and re-test affected workflows after doing so.
