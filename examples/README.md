# Example workflows

Importable n8n workflows demonstrating the operations of the Exasol node. Each workflow is
self-contained, safe to re-run (no manual cleanup needed between runs), and annotated below with
what it demonstrates and what output to expect. On the canvas, sticky notes next to each node
(or group of nodes) explain what it does and which node feature it showcases.

| File | Workflow | Story | Operations demonstrated |
| --- | --- | --- | --- |
| [01-flight-delay-report.json](01-flight-delay-report.json) | Exasol Demo 1 — Flight Delay Report | Report the top-10 airlines by flight count for the most recent month of data | Execute Query (with `?` parameters) |
| [02-retail-revenue-mart.json](02-retail-revenue-mart.json) | Exasol Demo 2 — Retail Revenue Mart | Mini-ETL: aggregate a large sales table into a small reporting table, refreshed idempotently | Execute Query (DDL + aggregation), Create or Update (upsert), Select Rows |
| [03-contact-crud-lifecycle.json](03-contact-crud-lifecycle.json) | Exasol Demo 3 — Contact List Lifecycle (CRUD) | Seed a contacts table, activate validated entries, purge the rest, read back the result | Execute Query (DDL), Insert, Update, Delete, Select Rows |
| [04-schema-data-dictionary.json](04-schema-data-dictionary.json) | Exasol Demo 4 — Schema Data Dictionary | Discover the database and emit a column-level data dictionary for one schema | List Schemas, List Tables, Describe Table |
| [05-ai-data-analyst-agent.json](05-ai-data-analyst-agent.json) | Exasol Demo 5 — AI Data Analyst (Agent) | Chat with an AI agent that explores the catalog and answers questions with guarded SELECTs | Exasol as an AI Agent tool: List Schemas, List Tables, Describe Table, Execute Query |

## Prerequisites

- These workflows are built against the **Exasol demo database**. If you don't already have
  credentials for it, request access via [Book a Demo](https://www.exasol.com/book-a-demo/). Each
  user of the demo database also gets their own personal schema with full read/write access,
  which the write demos below use.
- **Demos 1, 2 and 5** query the schemas `FLIGHTS` and `RETAIL` of the demo database. If your
  database does not have them, adjust the schema/table names in the query nodes — any reasonably
  large table works.
- **Demos 2 and 3** create small demo tables (prefix `N8N_DEMO_`). The target schema is **not
  hardcoded**: a leading "Resolve Write Schema" node runs
  `SELECT COALESCE(CURRENT_SCHEMA, CURRENT_USER)`, so writes go to the default schema configured
  in your credential — or, if none is set, to the schema named after your database user (the
  usual Exasol convention for a personal schema). Set the **Default Schema** field of your
  credential to redirect the writes.
- **Demo 4** only reads the system catalog; it filters for the `RETAIL` schema, which you can
  change in the "Keep RETAIL Schema" Filter node.
- **Demo 5** additionally needs a chat-model credential (the shipped workflow contains an OpenAI
  Chat Model node without credentials — attach your own, or swap in any other chat-model node).

## Importing

**UI:** in the n8n editor choose *Workflow menu (⋯) → Import from File…* and pick a JSON file.

**CLI:**

```bash
n8n import:workflow --separate --input=examples/
```

After importing, open each Exasol node and select **your own** Exasol credential — the workflows
reference a credential named "Exasol Demo DB" that does not exist in your instance. Credentials
are configured under *Credentials → Add credential → Exasol API* (host, port, user, password,
optional default schema, result row limit).

All Exasol nodes in the examples — including the tool nodes and the AI Agent node in Demo 5 —
have *Retry On Fail* enabled (3 tries), so a transiently dropped database connection does not
fail a demo run.

## The workflows in detail

### Demo 1 — Flight Delay Report

Two chained Execute Query nodes. The first finds the most recent `"YEAR"`/`"MONTH"` present in
`FLIGHTS.FLIGHTS` (~185M rows), so the workflow never goes stale. The second uses **`?`
placeholders** bound from the previous node's output to report the top-10 carriers of that month
with their average arrival delay. Both queries keep *Restrict to SELECT Queries* enabled and
aggregate with `GROUP BY`/`LIMIT`, which Exasol executes in well under a second even at this
table size. Note the double quotes around `"YEAR"` and `"MONTH"` — both are reserved words in
Exasol SQL.

**Expected output:** 10 items with `CARRIER`, `FLIGHT_COUNT`, `AVG_ARR_DELAY_MIN`.

### Demo 2 — Retail Revenue Mart

A miniature ETL pipeline. After resolving the write schema, an Execute Query node (with
*Restrict to SELECT Queries* disabled — one of only two DDL nodes in this set) runs
`CREATE TABLE IF NOT EXISTS … N8N_DEMO_DAILY_REVENUE`. The next node aggregates the last 14 days
of `RETAIL.SALES` (~585M rows), and **Create or Update** merges the result into the mart using
`SALES_DATE` as the conflict column — re-running the workflow refreshes the same 14 rows instead
of duplicating them. A final **Select Rows** node reads the mart back using a WHERE condition
collection (`REVENUE > 0`) and a sort rule (`SALES_DATE DESC`).

**Expected output:** the upsert reports `{ "affectedRows": 14 }` (the 14 most recent sales
dates). The read-back returns the mart's rows with positive revenue — on the static demo
database that is the same 14 items on every run. On a source whose data changes, the mart
accumulates dates across runs, and the `REVENUE > 0` filter may exclude zero-revenue days, so
the count can differ.

### Demo 3 — Contact List Lifecycle (CRUD)

Demonstrates the full write lifecycle on a table that the workflow itself resets with
`CREATE OR REPLACE TABLE`, making it fully idempotent. A Code node seeds three contacts (note the
UPPERCASE JSON keys — the node quotes identifiers, and Exasol stores unquoted names in
uppercase). **Insert** auto-maps them in one batched statement (`affectedRows: 3`). **Update**
uses *Map Each Column Below* plus a `LIKE '%@example.com'` WHERE condition to activate the two
valid contacts, stamping `UPDATED_AT` via an n8n expression. **Delete** removes the remaining
unvalidated contact. Update and Delete both require at least one WHERE condition — the node
refuses to update or delete an entire table.

**Expected output:** the final Select Rows returns exactly 2 items, both with
`STATUS = "active"`, on every run.

### Demo 4 — Schema Data Dictionary

Chains the three Schema Explorer operations: **List Schemas** emits every schema, a Filter node
keeps `RETAIL`, **List Tables** (with views included) fans out one item per table, and
**Describe Table** runs once per table item, emitting one item per column plus a summary item
with the table's constraints. The result is a column-level data dictionary of the schema.

**Expected output:** one item per column of every table/view in `RETAIL`, each with `name`,
`type`, `nullable`, `default`, `comment`, plus one `constraints` item per table.

### Demo 5 — AI Data Analyst (Agent)

The node declares `usableAsTool: true`, so n8n can hand it to an AI Agent as a tool. This
workflow wires four Exasol tool nodes to an agent behind a chat trigger:

- *List Schemas*, *List Tables*, *Describe Table* — the Schema Explorer operations, designed for
  agent-driven database discovery; the agent fills in schema/table names via `$fromAI()`.
- *Run SQL Query* — Execute Query with **Restrict to SELECT Queries enabled**. The option is not
  expression-capable, so the agent cannot turn it off; any non-SELECT statement it generates is
  rejected. The credential's *Result Row Limit* (default 1000) caps runaway result sets.

The system prompt instructs the agent to explore before querying and to always aggregate or
`LIMIT`. To try it: attach a chat-model credential to the Chat Model node, open the chat panel,
and ask e.g. *"Which schemas are in this database?"* or *"Top 5 airlines by flight count in the
latest month of data?"*.

## Safety notes

- The write demos touch only tables prefixed `N8N_DEMO_` in the resolved write schema. Nothing
  else is created, altered, or dropped; there is no `DROP` statement anywhere in the set.
- Demos 1 and 4 (and the agent's tools) are entirely read-only.
- Queries against large tables always aggregate and/or `LIMIT`.
