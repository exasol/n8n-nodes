# n8n-nodes-exasol
[![CI](https://github.com/exasol/n8n-nodes/actions/workflows/ci.yml/badge.svg)](https://github.com/exasol/n8n-nodes/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=com.exasol%3An8n-nodes&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=com.exasol%3An8n-nodes)

An n8n community node for interacting with Exasol databases.
 
Features:
 
- Execute custom SQL queries
- Insert, update, delete, and upsert records
- Select rows without writing SQL
- Explore schemas, tables, and metadata
- Use Exasol as a tool in n8n AI Agents
- Support for parameterized queries

## Compatibility

- Requires `n8n-workflow` `>=2.0.0`.
- CI tests against Node.js 22, 24, and 26.
- Depends on `@exasol/exasol-driver-ts` `^0.4.1`.
  
## Local Development Quick Start
To test locally, link the package into an n8n installation:

### Prerequisites
- Node.js
- npm
- n8n
- Access to an Exasol database

#### Step 1: Clone the repository
```bash
git clone https://github.com/exasol/n8n-nodes.git
cd n8n-nodes
```
#### Step 2: Community Node Installation
This node can be installed using any supported [n8n community-node installation](https://docs.n8n.io/integrations/community-nodes/installation/) method.

Package name: n8n-nodes-exasol (npm package; the GitHub repository is [exasol/n8n-nodes](https://github.com/exasol/n8n-nodes)).

To install locally:
```bash
npm install n8n -g
n8n --version
```

#### Step 3: Install dependencies
```bash
npm install
```

#### Step 4: Build the project
  ```bash
  npm run build
  npm run lint
```
See the [Developer Guide](doc/developer-guide.md) for the full contributor workflow, including running the test suites and testing against a local Docker database.

#### Step 5: Link the node
  ``` bash
  npm link
  npm link n8n-nodes-exasol
```
#### Step 6: Start n8n
  ``` bash
  n8n start
```
Open the n8n editor:
```text
http://localhost:5678
```
The Exasol node should now be available in the node picker.

#### Step 7: Verify the setup
 Create an Exasol [credential](https://github.com/exasol/n8n-nodes#credentials) and execute:
```sql
SELECT CURRENT_TIMESTAMP;
```
A successful response confirms that the node, credentials, and database connection are working correctly.

## Credentials
The Exasol node uses **ExasolApi** credentials. You will need:

- **Host** – Exasol database hostname
- **Port** – WebSocket port (default: `8563`)
- **User** – Database username
- **Password** – Database password
- **Schema** _(optional)_ – Default schema for queries
- **Result Row Limit** _(optional)_ – Maximum rows fetched per query (default: `1000`; `0` = no limit)

## Operations

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

These operations are commonly used in AI Agent workflows to understand database structure before generating SQL.
See the [User Guide](doc/user-guide.md) for each operation's fields and behavior (WHERE requirements, batching, execution modes, upsert conflict handling, and so on), and [Example workflows](#example-workflows) below for runnable demos of every operation.

## Example workflows
| Workflow | Purpose |
|-----------|----------|
| Demo 1 | Parameterized analytics query |
| Demo 2 | ETL and Upsert workflow |
| Demo 3 | CRUD lifecycle |
| Demo 4 | Schema data dictionary |
| Demo 5 | AI Data Analyst Agent |

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


## Version history

See [Changelog](doc/changes/changelog.md) for release notes.

## License

[MIT](LICENSE)
