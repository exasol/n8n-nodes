# Open questions

Design questions carried forward past v0.1.0, tracked so the rationale isn't lost.

## Session isolation in a future pooling design

The current connection model opens one connection per `execute()` call and closes it in a
`finally` block (see [Developer Guide](developer-guide.md)), which prevents any session state from
leaking between workflow executions by construction — there's nothing to reset because nothing is
reused.

No cross-invocation connection pooling exists in this project today. If one is added in the
future (the built-in Postgres node's approach, via `ConnectionPoolManager` — see
[community-vs-builtin.md](community-vs-builtin.md)), its design must explicitly reset session
state (autocommit, current schema, timezone) before returning a connection to the pool. Without
that reset, a later workflow execution could silently inherit session settings left behind by an
earlier one that borrowed the same pooled connection.
