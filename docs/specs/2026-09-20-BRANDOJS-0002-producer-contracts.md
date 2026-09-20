# BRANDOJS-0002: producer contracts

The Buma/Stemra API, postback receiver, and worker profiles submit work whose
handlers run in other processes. Version 0.1.0 couples submission validation to
executable registrations and rejects zero workers.

Add `actorContract({ type, state, messages })` for shared wire declarations.
`Brando.start({ actors: [], contracts: [contract], config: { workerCount: 0 } })`
starts a producer/inspection client with no worker or maintenance loops. Workers
may declare outbound contracts without claiming those actor types. Existing
actor definitions implicitly supply their own contracts and remain compatible.

Only executable actors participate in claims and reminder materialization.
`submit`, `submitJson`, transactional sends, and the operations catalogue use the
combined contract registry. Local reminders still require a local unit handler.
Conflicting contracts fail startup before any database work. Durable names,
payload validation, fencing, deduplication, and store schema do not change.

Verify with serial fresh-schema PostgreSQL tests: work remains pending while
only clients are running; a separate worker consumes it; a worker sends to an
unregistered outbound actor atomically; failed turns do not leak sends; client
shutdown releases resources; incompatible contracts fail. Verify the dashboard
before/after, package exports, full lint/typecheck/build/tests, and startup.
