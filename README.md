# n8n-nodes-exasol

[![CI](https://github.com/exasol/n8n-nodes/actions/workflows/ci.yml/badge.svg)](https://github.com/exasol/n8n-nodes/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=com.exasol%3An8n-nodes&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=com.exasol%3An8n-nodes)

n8n community nodes for [Exasol](https://www.exasol.com/).

[Installation](#installation)  
[Operations](#operations)  
[Credentials](#credentials)  
[Compatibility](#compatibility)  
[Example workflows](#example-workflows)  
[Resources](#resources)  
[Version history](#version-history)

## Installation

Follow the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) to install this package in your n8n instance.

Package name: `n8n-nodes-exasol` (npm package; the GitHub repository is [exasol/n8n-nodes](https://github.com/exasol/n8n-nodes)).

## Operations

### Database

| Operation | Description |
| --- | --- |
| Execute Query | Execute one or more SQL statements |
| Select Rows | Select rows from a table using structured filters |
| Insert | Insert rows into a table |
| Update | Update rows in a table using structured filters |
| Delete | Delete rows from a table using structured filters |
| Create or Update | Create a new record, or update the current one if it already exists (upsert) |

### Schema Explorer (read-only, for AI agent use)

| Operation | Description |
| --- | --- |
| List Schemas | List all schemas in the database |
| List Tables | List tables (and optionally views) in a schema |
| Describe Table | Describe a table or view's columns and constraints |

See the [User Guide](doc/user-guide.md) for each operation's fields and behavior (WHERE requirements, batching, execution modes, upsert conflict handling, and so on), and [Example workflows](#example-workflows) below for runnable demos of every operation.

## Credentials

The Exasol node uses **ExasolApi** credentials. You will need:

- **Host** – Exasol database hostname
- **Port** – WebSocket port (default: `8563`)
- **User** – Database username
- **Password** – Database password
- **Schema** _(optional)_ – Default schema for queries
- **Result Row Limit** _(optional)_ – Maximum rows fetched per query (default: `1000`; `0` = no limit)

## Compatibility

- Requires `n8n-workflow` `>=2.0.0`.
- CI tests against Node.js 22, 24, and 26.
- Depends on `@exasol/exasol-driver-ts` `^0.4.1`.

## Example workflows

Importable demo workflows covering all operations — including using the node as an AI Agent
tool — live in [examples/](examples/README.md).

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Exasol documentation](https://docs.exasol.com/)
- [exasol-driver-ts](https://github.com/exasol/exasol-driver-ts)
- [User Guide](doc/user-guide.md) — per-operation field reference
- [Developer Guide](doc/developer-guide.md) — contributor onboarding, build/test workflow
- [Community node vs. built-in node gaps](doc/community-vs-builtin.md)
- [Open questions](doc/open-questions.md)

## Development

```bash
npm install
npm run build
npm run lint
```

To test locally, link the package into an n8n installation:

```bash
npm link
# In your n8n directory:
npm link n8n-nodes-exasol
```

See the [Developer Guide](doc/developer-guide.md) for the full contributor workflow, including running the test suites and testing against a local Docker database.

## Version history

See [Changelog](doc/changes/changelog.md) for release notes.

## License

[MIT](LICENSE)
