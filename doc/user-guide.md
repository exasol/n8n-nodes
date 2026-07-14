# User Guide

Field-level reference for each of the Exasol node's 9 operations: what it does, its fields, and
the behavioral details that aren't obvious from the field labels alone. For runnable, end-to-end
scenarios with expected output, see [examples/README.md](../examples/README.md) instead — this
guide is a reference, not a tutorial.

All Database operations (everything except the three Schema Explorer operations) take a **Schema**
and **Table** field backed by dropdowns populated from the database; you can also type in a value
using an [n8n expression](https://docs.n8n.io/code/expressions/) instead of picking from the list.

## Database operations

### Execute Query

Runs freeform SQL. Fields:

- **SQL Query** – the statement to run. Use `?` placeholders bound by the **Parameters** list below.
- **Restrict to SELECT Queries** – default **on**. Rejects any statement that isn't a read-only
  `SELECT` (or `WITH ... SELECT`) before it reaches the database, including a `SELECT ... INTO`
  clause (which creates and populates a target table despite starting with `SELECT`). This setting
  cannot be set via an n8n expression — it's a workflow-design-time choice, not data-driven — which
  matters because it means an AI agent driving this node as a tool can never flip it off itself.
  Disable it only for trusted workflows that need Execute Query to run
  `INSERT`/`UPDATE`/`DELETE`/DDL.
- **Parameters** – repeatable list of values bound to the query's `?` placeholders, left to right.
- **Execution Mode** – how multiple input items are processed:
  - **Sequentially** (default) – one auto-committed query per item; a failure stops processing
    unless `continueOnFail` is enabled.
  - **Transaction** – all items run in a single database transaction; any failure rolls back every
    item.
  - **Single Batch** – all items sent in one round-trip. Only works when no item uses Parameters —
    it silently falls back to Sequentially if any item does. If the batch fails, every item is
    reported as failed with the same error message, since a batch failure can't be attributed to
    one specific item.

### Select Rows

Structured `SELECT` built from a schema/table picker instead of raw SQL. Fields:

- **Return All** / **Limit** – return every matching row, or cap it at **Limit** (default 50).
- **Where** – repeatable list of `{ column, operator, value }` conditions, combined with a single
  AND/OR choice across all of them. Operators: equals, not equals, less/greater than (or equal),
  LIKE/NOT LIKE, REGEXP_LIKE/NOT REGEXP_LIKE, IS NULL/IS NOT NULL (the last two ignore the value).
  No conditions means no `WHERE` clause — every row is returned (subject to Limit).
- **Sort** – repeatable list of `{ column, direction }` rules, applied in priority order.

### Insert

Batches every input item into a single multi-row `INSERT` statement (one round-trip regardless of
item count). Returns `{ affectedRows: N }` only — Exasol has no `RETURNING` clause, so inserted
rows are never echoed back. Fields:

- **Data Mode** – **Auto-Map Input Data** (default) uses the first input item's JSON keys as the
  column list and every item's own values as its row, or **Map Each Column Below** to set an
  explicit column/value list (values support expressions, evaluated per item).

### Update

Issues one `UPDATE` statement per input item (unlike Insert, since one `WHERE` match can affect
several rows per item). Returns `{ affectedRows: N }`. Fields:

- **Data Mode** – same Auto-Map / Map Each Column Below choice as Insert, but for the `SET` clause.
- **Where** – same shape as Select Rows, but **required**: an item with no conditions is rejected
  rather than updating every row in the table.

### Delete

Issues one `DELETE` statement per input item. No column mapping (there's no `SET` clause) — just
the schema/table pickers and **Where**, required for the same reason as Update: an empty `Where`
is rejected rather than deleting every row. Returns `{ affectedRows: N }`.

Unlike Select Rows and Update, Delete's `Where` values are inlined as SQL literals rather than
bound as `?` parameters — Exasol's prepared `DELETE` only accepts parameterized conditions of the
exact shape `<column> = ?`, ANDed together; anything else (a different operator, or an `OR`
combinator) is rejected server-side. This is invisible in the UI — every operator on the Where
field still works — but it means Delete's WHERE values are never sent as bound parameters the way
Select Rows' and Update's are.

### Create or Update (Upsert)

Batches every input item into a single generated `MERGE INTO ... USING (VALUES ...) ...`
statement (one round-trip regardless of item count) — Exasol has no `INSERT ... ON CONFLICT`.
Returns `{ affectedRows: N }`. Fields:

- **Data Mode** / **Columns** – same Auto-Map / Map Each Column Below pattern as Insert.
- **Conflict Columns** – which of the mapped columns identify an existing row. These form the
  `MERGE`'s `ON` clause; every other mapped column is written when a row matches, and a row with no
  match is inserted.

Two validation rules worth knowing before they surprise you at runtime:

- A row with a `NULL`/missing value in a Conflict Column is **rejected** rather than silently
  inserted as a duplicate. Exasol's `MERGE ON` clause only supports `=`, which never matches
  `NULL`, so a `NULL` conflict value can't be matched safely at the SQL level.
- Two or more rows in the same batch sharing the same Conflict Column value(s) are also
  **rejected** up front, before the statement runs. `MERGE` only matches source rows against the
  target table, never against each other, so without this check an in-batch duplicate would either
  raise an opaque database error or silently insert two rows instead of one — rejecting it early
  turns both possible outcomes into one clear, actionable error instead.

Like Delete, row values are inlined as SQL literals rather than bound `?` parameters (Exasol's
prepared-statement support rejects a `VALUES(?, ?)` list used as a MERGE source).

## Schema Explorer operations

Read-only queries against Exasol's `EXA_ALL_*` system catalog views, intended primarily for AI
agent database discovery (see [examples/README.md](../examples/README.md) Demo 4/5). Unlike the
Database operations above, these have no `Table`/Schema **write** target — Schema is used only to
scope the lookup.

### List Schemas

No fields beyond the standard ones. Returns one item per schema in the database.

### List Tables

- **Schema** – schema to list tables from.
- **Include Views** – default off. When enabled, views are unioned into the results alongside
  tables, each row tagged with a `type` of `"TABLE"` or `"VIEW"`.

### Describe Table

- **Schema**, **Table or View** – the table or view to describe (its picker includes views, unlike
  every other operation's Table field, which only offers tables).

Returns one item per column (`name`, `type`, `nullable`, `default`, `comment`), followed by one
summary item `{ constraints: [...] }`. A composite `PRIMARY KEY`/`FOREIGN KEY` that spans several
columns is collapsed into a single constraint object with a `columns` array, rather than one item
per column. Exasol's auto-generated `SYS_`-prefixed names (for constraints the user never
explicitly named) are reported as `name: null` rather than surfacing the internal identifier.
