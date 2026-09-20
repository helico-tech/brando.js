# Verification — BRANDOJS-0001

Environment: Linux x86-64, Node 24.14.0, pnpm 11.25.0, TypeScript 6.0.3, PostgreSQL 17.11 (real `postgres:17-alpine` container). Reference Brando commit: `6a07d99`. Date: 2026-09-20.

Executed gates:

- `pnpm check`: strict typecheck, ESLint with zero warnings, issue/layout validation, Prettier check, 29 tests across 5 suites, and production JS/declaration/dashboard build.
- `pnpm test:browser`: 3 Chromium tests against the production dashboard and real PostgreSQL in a fresh schema. Covers submission, state inspection, terminal failure, resubmission, reminder/catalogue/runtime navigation, mobile overflow, and read-only controls. Browser console warnings/errors are checked.
- `pnpm test:package`: packs and installs into an isolated consumer, runs ESM imports of all public subpaths, exercises the kernel, loads via Node CommonJS, and typechecks a separate TypeScript consumer with declarations.
- `pnpm start`: HTTP service started at 127.0.0.1:3000 with real PostgreSQL; readiness and browser actions verified.
- `pnpm dashboard`: Vite start script executed and both HTML and the API proxy verified. Port 5173 was occupied by an existing service, so Vite chose 5174; the verification server was stopped afterward.
- `playwright-cli`: before/after desktop screenshots, manual durable message submission, mobile screenshot and console checks. The initial workspace was empty, so the before screenshot is an empty browser.

Conformance coverage includes duplicate/conflicting submissions, resumption after restart, two-replica mailbox ordering, atomic state/sends/reminders, terminal-failure rollback, unexpired lease renewal, stale-fence rejection, actual SIGKILL of an owning process and recovery, graceful shutdown recovery, local wait timeout, canonical IDs, application isolation, finite retention and incarnation reuse, schema validation, borrowed-pool ownership, unknown-message grace, incompatible-state recovery, unknown state fields, direct-mutation isolation, escaped-scope sealing, and four ordinary-actor primitives.

Review caught two regressions before release: unknown reminders could monopolize a due scan, and committed JSON null state was indistinguishable from uninitialized state. Failing tests preceded their fixes. The packed-consumer gate also caught a TypeScript 6 command-line configuration change; the consumer now explicitly compiles independently of the repository config.

No claim is made that this suite certifies every Kotlin-specific acceptance criterion or the upstream performance suite. Exact adaptations and operational limitations are in [semantics](../domain/semantics.md) and [operations](../domain/operations.md).

Evidence: [before](dashboard-before.png), [desktop](dashboard-after.png), [mobile](dashboard-mobile.png).

GitHub Actions also passed the complete checks, browser flows and packed-consumer suite for implementation commit `0cd47a7`: [Verify run 35508440623](https://github.com/helico-tech/brando.js/actions/runs/35508440623).
