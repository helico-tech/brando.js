# brando.js

**Durable virtual actors for TypeScript and JavaScript. PostgreSQL is the only infrastructure.**

A TypeScript implementation of [Brando](https://github.com/helico-tech/brando), with sequential async handlers, durable mailboxes, fenced leases, transactional sends and reminders, resumable results, and a bundled **React + shadcn/ui** operations dashboard.

![Brando operations dashboard](docs/context/dashboard-after.png)

## Quick start

Requires **Node.js 24+**, **pnpm 11.25**, and **PostgreSQL 17+**. PostgreSQL 17 is exercised in CI.

```sh
git clone https://github.com/helico-tech/brando.js.git
cd brando.js
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm build
pnpm start
```

Open **http://127.0.0.1:3000**. The example seeds a small set of real actors and a recurring schedule; every chart and table reads the running PostgreSQL application. Use **Send message** with `counter.add`, actor ID `"my-counter"`, and payload `{"amount": 3}`. Inspect its result and actor state afterward.

The demo binds to loopback. To expose it, set `BRANDO_TOKEN` and put HTTPS in front of it. The dashboard accepts the bearer token and keeps it only in page memory. `SEED_DEMO=false` disables example seeding. See [.env.example](.env.example).

## Install in your project

The GitHub release includes a built, installable package, with JavaScript, declarations, source maps, and dashboard assets:

```sh
pnpm add https://github.com/helico-tech/brando.js/releases/download/v0.1.0/helico-tech-brando.js-0.1.0.tgz
```

The package name is **`@helico-tech/brando.js`**. It is published through GitHub releases; no npm registry publication is implied. You can also build this repository and run `pnpm pack` to produce the same package locally. ESM imports and Node 24 `require()` are supported. The runtime uses `pg` and Zod; React is bundled into the optional dashboard and is not a runtime dependency of your application.

## Define an actor

```ts
import { z } from 'zod';
import { Brando, actorType, codec, defineActor, message } from '@helico-tech/brando.js';

const Counters = actorType({ name: 'counter', id: codec('string', z.string()) });
const Add = message({
  name: 'counter.add.v1',
  payload: z.object({ amount: z.number() }),
  result: codec('number', z.number()),
});
const counter = defineActor({
  type: Counters,
  state: codec('counter.state.v1', z.object({ value: z.number() })),
  initial: () => ({ value: 0 }),
  handlers: (on) => [
    on(Add, (ctx, { amount }) => {
      return ctx.update((state) => ({ value: state.value + amount })).value;
    }),
  ],
});

const brando = await Brando.start({
  name: 'my-application',
  database: process.env.DATABASE_URL!,
  actors: [counter],
});

const value: number = await brando.call({
  target: Counters.ref('homepage'),
  message: Add,
  payload: { amount: 10 },
  invocationId: 'request-123',
});

await brando.close();
```

For JavaScript, remove the type annotation and the `!` assertion. Handlers return their typed result directly; a `unit` result handler returns nothing. IDs and messages have runtime Zod validation as well as compile-time types. Durable names must remain stable across deployments.

The database may be a connection string or your own `pg.Pool`. Brando closes only pools it creates. A borrowed pool needs at least `workerCount + 3` connections and bounded connection/statement timeouts. Use `await using brando = await Brando.start(...)` for automatic disposal where supported.

## Submit, disconnect, resume

```ts
const accepted = await brando.submit({
  target: Counters.ref('homepage'),
  message: Add,
  payload: { amount: 1 },
  invocationId: 'checkout-42',
});
// This point means PostgreSQL committed acceptance.
const result = await accepted.await({ timeoutMs: 5000 });

// On a later connection or process:
const recovered = await brando.invocation({ id: 'checkout-42', result: Add.result });
if (recovered) console.log(await recovered.await());
```

An aborted or timed-out wait does **not** cancel accepted work. Reusing a retained ID with the identical request returns its existing outcome; changing its target, message, payload, or result type throws `InvocationIdConflict`. A failed submission with an unknown commit outcome throws `AmbiguousSubmission` containing the ID to reuse.

## Atomic sends and reminders

```ts
import { unit } from '@helico-tech/brando.js';

const Tick = message({ name: 'counter.tick.v1', payload: z.object({}), result: unit });

// Within a registered handler:
ctx.send({ target: Counters.ref('another'), message: Tick, payload: {} });
ctx.remind({ name: 'next-tick', afterMs: 60_000, message: Tick, payload: {} });
ctx.cancelReminder('old-timer');
```

Sends and reminders require a registered `unit` handler. They commit together with the source state and result. `afterMs` starts from the successful commit transaction’s PostgreSQL time; `at: new Date(...)` is also supported. The last operation for a reminder name wins. Cancellation cannot retract a reminder already materialized into the ordinary mailbox.

Use `ctx.idempotencyKey('charge')` with an external provider that honors that key. `ctx.signal` reports lease loss or shutdown; abort external work cooperatively. Arbitrary external effects do not join the PostgreSQL transaction.

## Test handlers without PostgreSQL

```ts
import { actorTurnTest } from '@helico-tech/brando.js/testing';

const turn = await actorTurnTest({
  actors: [counter],
  actor: counter,
  id: 'homepage',
  state: { value: 7 },
  message: Add,
  payload: { amount: 3 },
});
// turn.state.value === 10; turn.result === 10
// Inspect turn.sends and turn.reminders for buffered effects.
```

The test kit executes the production turn kernel. It does not simulate leases, scheduling, or durable storage; those guarantees are tested against real PostgreSQL.

## Reusable primitives

Import from `@helico-tech/brando.js/primitives`:

| Factory                                             | Messages                                        | Behavior                                                                     |
| --------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `rateLimiter({ type, capacity, refillMs })`         | `Acquire`, `ConfigureBucket`, `ReadBucket`      | Per-key token bucket with durable refill reminders                           |
| `recurringSchedule({ type, onOccurrence })`         | `StartSchedule`, `StopSchedule`, `ReadSchedule` | Relative cadence, generation guards, skipped downtime occurrences            |
| `retryRunner({ type, operation })`                  | `StartRetry`, `ReadRetry`                       | Modeled retries, doubling backoff, attempt limit, one persisted provider key |
| `heartbeatMonitor({ type, onAlert, onResolution })` | `Pulse`, `ReadMonitor`                          | Generation-guarded silence detection and alert resolution                    |

Factories return ordinary actor definitions for the `actors` array. Effects receive `{ scope, occurrence }` or `{ scope, generation }` and can call `scope.send`. Retry operations receive `{ providerKey, payload, attempt, signal }` and return `'success'` or `'retry'`; thrown exceptions terminally fail the invocation. See the [executable example](examples/actors.ts) and [primitive tests](tests/primitives.test.ts).

## Embed the dashboard or API

```ts
import { createDashboardServer } from '@helico-tech/brando.js/http';

const server = createDashboardServer({
  runtime: brando,
  authorize: async (request) => {
    const user = await authenticate(request); // your application’s authentication
    return user?.admin ? 'write' : user?.operator ? 'read' : false;
  },
});
server.listen(3000, '127.0.0.1');
```

`createOperationsHandler({ runtime, authorize })` exposes the same API as a standard `Request → Promise<Response>` function for framework integration. Authentication is required at construction. Reads and writes have separate permissions; mutations reject cross-origin browser requests and bodies over 1 MiB. No permissive CORS is enabled. The bundled dashboard expects `/api/brando` on its origin.

Views cover overview, paginated actors/invocations/reminders, actor state/history, failure details, registered schemas, replica metrics, and live readiness. Resubmitting a terminal invocation creates a new ID and may repeat its business effects. See [operations and HTTP routes](docs/domain/operations.md).

## Guarantees and boundaries

- Durable acceptance before acknowledgment, and mailbox ordering per actor.
- At-least-once handler attempts; at most one durable outcome per **retained** invocation ID.
- Database-time leases and monotonically increasing fencing tokens reject stale owners.
- State, result, sends, and reminder changes commit atomically.
- Ordinary handler exceptions are terminal; process loss, lease loss, and database interruption permit recovery.
- Thirty-day terminal-result retention by default. Expired IDs may create new work.
- PostgreSQL is the authority. There is no in-memory fallback, broker, partition assignment, or distributed transaction.

This port preserves Brando’s durable actor model. It does **not** share Kotlin’s wire format, database schema, coroutine implementation, or JVM serializers. Read the [semantic correspondence and differences](docs/domain/semantics.md) before migrating an application. Version 0.1.0 has local and CI conformance coverage; it does not claim the Kotlin implementation’s production history or throughput certification.

## Develop and verify

```sh
pnpm check          # typecheck, lint, formatting, unit/real-PG tests, production build
pnpm test:browser   # production dashboard, real PostgreSQL, fresh schema
pnpm test:package   # pack and install in an isolated JS/TS consumer
pnpm dashboard     # Vite development server at :5173; run pnpm start for the API
```

`TEST_DATABASE_URL` changes the verification database; default `postgres://brando:brando@127.0.0.1:55432/brando`. Database suites run serially and create fresh schemas. Browser checks also create and clean a unique schema. No tests run in watch mode. Install the local push gate with `git config core.hooksPath .githooks`.

[Architecture decision](docs/adr/2026-09-20-0001-typescript-runtime.md) · [Verification record](docs/context/verification.md) · [Apache-2.0 license](LICENSE)
