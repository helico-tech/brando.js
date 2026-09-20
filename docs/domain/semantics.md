# Semantic correspondence

Reference: Brando `6a07d99`, `BRANDO_V1_ARCHITECTURE.md` §§7–14 and production TurnKernel/Store. This is a behavior port, not shared-storage or binary compatibility.

| Brando concept                 | brando.js                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Actor type plus serialized ID  | `actorType({ name, id: codec(...) })`; ID JSON canonicalized and SHA-256 indexed, with full identity collision validation         |
| Explicit serializer identities | Named Zod codecs for actor ID, state, message and result                                                                          |
| Suspending sequential handler  | Async handler, one valid lease owner per actor, body outside a DB transaction                                                     |
| `reply(value)`                 | Return the result; `unit` returns undefined, stored as JSON null                                                                  |
| `update`                       | Replacement candidate; without update the exact baseline serialization is retained                                                |
| Buffered sends                 | Deterministic `brando:send:<incarnation>:<ordinal>` IDs, atomically enqueued                                                      |
| Named reminders                | Last operation wins; relative time uses the commit transaction’s PostgreSQL time                                                  |
| Reminder generation            | `brando:reminder:<incarnation>:<remind ordinal>`; materialized atomically with ordinary enqueue                                   |
| Invocation identity            | Application-scoped caller ID, exact payload/target/type comparison, reserved internal namespace                                   |
| Lease                          | PostgreSQL clock, renewed below half the duration, incrementing bigint fence on every claim                                       |
| Fenced commit                  | Deterministic source-plus-target lock order; validate owner, fence, unexpired lease, state revision and earliest nonterminal head |
| Failure                        | Application/contract failure is terminal; buffered data discarded; the next head proceeds                                         |
| Interrupted attempt            | Remains nonterminal; next owner reruns from committed state; terminal result checked before replay                                |
| Local cancellation             | Stops waiting only; `ctx.signal` separately reports runtime attempt cancellation                                                  |
| Retention                      | Deletes only terminal rows, in bounded, draining, SKIP LOCKED batches; state and reminders remain                                 |
| Schema management              | Apply rolling-safe (default), apply all, or validate only; reject newer runtime versions                                          |
| One-turn test                  | `actorTurnTest`, using the same production kernel                                                                                 |

**At-least-once attempts, at most one committed outcome per retained ID.** No exactly-once execution, atomic external I/O, exact reminder timing, global message order, or unconditional completion. Different business requests with different IDs are distinct invocations. A retained failed ID returns the same failure; a business retry requires a fresh ID. If an ID is reused after retention, a fresh noncycling database incarnation prevents collision with old children.

The canonical JSON boundary rejects undefined (except unit results), NaN/infinity, BigInt, cycles, nonplain objects, NUL and malformed Unicode rather than silently changing them. Use strings for values that need precision beyond JavaScript safe integers, and Zod `safe()` for numeric counters. PostgreSQL bigint coordination values stay strings. Treat state as immutable. Zod object state updates preserve unknown stored object fields using schema properties; arrays, records and union values are replacement values. Migration logic belongs in a compatible state codec or a stopped, explicit data migration.

A missing actor registration is left to compatible replicas. An unreadable state is actor-level and remains nonterminal; this replica backs off. An unknown message is deferred for five minutes by default, then terminally fails. A known undecodable message or changed result contract terminally fails its invocation. Unknown reminder message types remain scheduled for a compatible replica, and do not starve known reminders. Stored terminal-result decode failure affects retrieval only.

## JavaScript adaptations

- Explicit named messages replace Kotlin reified message classifiers. Registration identity is checked before submission and managed effects; arbitrary classes are not serialized.
- Promises cannot be forcibly stopped. Lease loss aborts the scope, frees the worker, and fences all commits, but noncooperative external work can continue. Do not block the Node event loop; use an external worker for CPU-heavy work. Process crashes may overlap attempts just as JVM pauses can.
- Correctness uses bounded polling (250 ms by default), rather than Kotlin’s LISTEN/NOTIFY wake optimization. This changes idle cost and latency, not acceptance, ordering or fencing.
- The package includes Prometheus-style replica counters, events and SQL-backed inspection. Kotlin’s built-in OpenTelemetry spans, table vacuum/storage controls and maintenance state-migration utilities are not cloned APIs. Wire contracts, database tables, and platform-specific exceptions differ.
- Unknown fields on class-like objects are retained; arrays, dynamic maps and unions use replacement values, matching the reference kernel’s collection and sealed-root policy.

Never run this port against a Kotlin Brando schema. Deploying two JavaScript replicas with the same application and schema shares one application; different application names isolate identities within that schema. Separate schemas isolate migrations.

## Producer-only clients (BRANDOJS-0002)

Outbound contracts and executable actors have separate registries. Only executable
actor types are claimed; only their local handlers materialize reminders. A runtime
with zero workers performs neither claim nor maintenance polling. Outbound sends
use declared contracts while local reminders still require executable unit handlers.
The database schema and atomic commit boundary are unchanged.
