# Operations

Start with a PostgreSQL primary using durable commit settings and sufficient disk, backup and failover policy. The runtime never acknowledges acceptance before commit. Standby promotion and external I/O reliability remain deployment responsibilities.

`Brando.start({ name, database, actors, config, onEvent })` accepts a connection string or a borrowed `pg.Pool`. Brando-created pools have workerCount + 4 connections, 5 s connection timeout, 10 s statement timeout and 15 s idle-transaction timeout. Borrowed pools are never closed and must have appropriate limits. Handlers do not hold database connections while awaiting I/O.

| Configuration                                | Default              |
| -------------------------------------------- | -------------------- |
| `schema`                                     | `brando_js`          |
| `schemaManagement`                           | `apply-rolling-safe` |
| `workerCount`                                | 4                    |
| `leaseDurationMs` / `leaseRenewalMs`         | 30,000 / 10,000      |
| `gracefulShutdownMs`                         | 30,000               |
| `pollIntervalMs` / `reminderIntervalMs`      | 250 / 250            |
| `maxMessagesPerClaim` / `maxDrainMs`         | 50 / 5,000           |
| `terminalRetentionMs`                        | 30 days              |
| `retentionIntervalMs` / `retentionBatchSize` | 1 hour / 1,000       |
| `unknownMessageGraceMs`                      | 5 minutes            |

Numbers are positive safe integers. Renewal must be below half the lease duration. Use `schemaMigrations({ schema })` for explicit SQL and `migrateSchema({ database: pool, schema, mode })` for deployment-time migration. An advisory lock serializes concurrent startup migration. A migration role needs DDL; a validated runtime role needs SELECT/INSERT/UPDATE/DELETE on runtime tables, schema USAGE and sequence USAGE/SELECT.

`close()` stops submissions and new claims, lets the current handler finish up to the configured grace, then aborts attempts and releases leases. It never erases durable state. Runtime-owned database operations remain bounded by their statement timeout; the shutdown grace is not a hard kill deadline for a custom pool. Close the host HTTP server too. Configure orchestrator grace beyond handler grace plus database timeout.

## HTTP

All routes below are under `/api/brando` by default and require the host’s `authorize(Request)` callback. It returns `'read'`, `'write'` or `false`. The static dashboard contains no secret or payload until authenticated API reads complete.

| Method and path                     | Purpose                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| GET `/session`                      | Effective read/write permission                                        |
| GET `/health/live`, `/health/ready` | Process lifecycle and a current database/schema probe                  |
| GET `/overview`                     | Health, retained status counts, actors/reminders, last-hour outcomes   |
| GET `/catalogue`                    | Registered ID, state, message and result JSON schemas                  |
| GET `/actors`                       | Actor page with state, revision, lease and pending count               |
| GET `/actor?type=...&id=<JSON>`     | State, latest 100 messages, first 100 reminders                        |
| GET `/invocations`                  | Invocation page with payloads, results and failures                    |
| GET `/invocations/:id`              | One retained invocation                                                |
| GET `/reminders`                    | Due-ordered pending reminders                                          |
| GET `/metrics`                      | Replica counters in Prometheus text format                             |
| POST `/submit`                      | `{ actorType, id, messageType, payload, invocationId? }` → accepted ID |
| POST `/resubmit`                    | `{ id, invocationId? }` → fresh invocation of a terminal request       |

Lists accept `limit` (1–200) and `offset` (0–1,000,000). Actors/invocations support `search`, plus `actorType`; invocations support `status`. Reminder lists support `actorType`. Offset pagination is a changing live view, not a transactionally consistent export. Inspection reads may reveal sensitive application state: authorization is an application responsibility.

The mutation gate requires write permission, same-origin browser requests, JSON content type and body size at most 1 MiB. No CORS wildcard or unauthenticated management default exists. A host proxy must preserve the real origin or adapt the Fetch request accordingly. Do not embed secrets in actor payloads or failure text; error summaries are bounded to 2,000 characters, not automatically redacted. HTTP database errors omit server details.

`onEvent` reports completed/failed attempts, runtime errors, incompatible actors and lease loss. Observer exceptions cannot change durable outcomes. Metrics are replica-local since startup; dashboard counts query retained database rows, so retention changes historical totals. API overview counts are intended for operational inspection, not accounting ledgers or unbounded high-frequency analytics.
