# brando.js 0.1.0

An installable TypeScript/JavaScript implementation of Brando’s PostgreSQL-backed durable actor model, with a live shadcn/ui operations dashboard.

- Typed actor definitions and Zod codecs; ESM, Node 24 CommonJS, TypeScript declarations and source maps.
- Ordered durable mailboxes, idempotent acceptance, resumable results, database-time leases and fenced commits.
- Atomic state, results, actor sends and named reminders; bounded retention and crash recovery.
- Rate limiter, recurring schedule, retry runner and heartbeat monitor, implemented as ordinary actors.
- Authenticated Fetch API adapter and embeddable Node dashboard server; inspection, submission and explicit resubmission.
- Real PostgreSQL conformance tests, actual process-kill recovery, responsive browser tests and isolated package-consumer validation.

Install the attached package:

```sh
pnpm add https://github.com/helico-tech/brando.js/releases/download/v0.1.0/helico-tech-brando.js-0.1.0.tgz
```

Import from `@helico-tech/brando.js`, `/testing`, `/primitives` or `/http`. Node 24+ and PostgreSQL 17 are the tested runtime baseline. No npm registry publication is implied.

The actor semantics follow the Kotlin reference; database schemas and wire formats are separate. Guarantees are at-least-once attempts and at most one durable outcome per retained invocation ID. See the README and `docs/domain/semantics.md` for platform adaptations and the exact compatibility boundary.

Validation: 29 unit/PostgreSQL/API tests, 3 Chromium flows, strict typecheck/lint/format/build, and installed ESM/CommonJS/TypeScript consumers, passing locally and in GitHub Actions.
