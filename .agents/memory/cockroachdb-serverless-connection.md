---
name: CockroachDB Serverless connection quirks in this environment
description: SSL cert handling and schema-push caveats when connecting this Replit container to a real CockroachDB Serverless cluster.
---

`psql` fails against CockroachDB Serverless with `sslmode=verify-full` unless
given a root CA: `root certificate file "/home/runner/.postgresql/root.crt"
does not exist`. Fix by appending `&sslrootcert=system` to the connection
string when using `psql` from the shell, e.g.
`psql "${COCKROACHDB_URL}&sslrootcert=system" -f schema.sql`.

**Why:** psql defaults to looking for a local root cert file when
`sslmode=verify-full` is set and none is given; `sslrootcert=system` tells it
to trust the OS CA bundle instead, which is enough for CockroachDB Cloud's
public-CA-signed certs.

Node's `pg` driver does **not** need this — connecting with just
`new Pool({ connectionString: process.env.COCKROACHDB_URL })` (no
`sslrootcert` param) worked fine in this environment, since Node's bundled
CA trust already covers CockroachDB Cloud's cert chain.

**How to apply:** when applying/updating schema on a CockroachDB Serverless
cluster from this container, prefer `psql "$URL&sslrootcert=system" -f
schema.sql` over `drizzle-kit push` — CockroachDB's dialect quirks (native
`VECTOR` type, `CREATE VECTOR INDEX` syntax) aren't guaranteed compatible
with `drizzle-kit push`'s Postgres introspection. Write schema changes by
hand in a `.sql` file tailored to CockroachDB and apply it directly; use
Drizzle only for querying (`drizzle-orm/node-postgres`), not for pushing
DDL, on CockroachDB.
