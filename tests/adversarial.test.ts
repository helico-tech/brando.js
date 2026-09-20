import { afterEach, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Brando,
  WaitAborted,
  actorType,
  codec,
  defineActor,
  message,
  migrateSchema,
  unit,
} from '../src/index.js';
import { LeaseLost, registry } from '../src/model.js';
import { envelope } from '../src/kernel.js';
import { Store } from '../src/store.js';
const database = process.env.TEST_DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando';
let pool: Pool;
let schema: string;
let runtimes: Brando[];
const type = actorType({ name: 'counter', id: codec('string', z.string()) });
const Add = message({ name: 'add', payload: z.object({}), result: codec('number', z.number()) });
const Tick = message({ name: 'tick', payload: z.object({}), result: unit });
const state = codec('counter.v1', z.object({ n: z.number() }));
const actor = defineActor({
  type,
  state,
  initial: () => ({ n: 0 }),
  handlers: (on) => [on(Add, (ctx) => ctx.update((s) => ({ n: s.n + 1 })).n), on(Tick, () => {})],
});
beforeEach(async () => {
  schema = `fault_${randomUUID().replaceAll('-', '')}`;
  pool = new Pool({ connectionString: database });
  runtimes = [];
  await migrateSchema({ database: pool, schema });
});
afterEach(async () => {
  await Promise.all(runtimes.map((r) => r.close()));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});
async function start(actors = [actor], config = {}) {
  const runtime = await Brando.start({
    name: 'test',
    database,
    actors,
    config: {
      schema,
      workerCount: 1,
      pollIntervalMs: 10,
      leaseDurationMs: 1000,
      leaseRenewalMs: 200,
      ...config,
    },
  });
  runtimes.push(runtime);
  return runtime;
}
it('rejects a stale fence before any state, result, child or reminder writes', async () => {
  const store = new Store(pool, schema, 'test');
  const request = envelope({
    registrations: registry([actor]),
    target: type.ref('a'),
    message: Add,
    payload: {},
  });
  await store.submit(request, 'parent');
  const owner = randomUUID();
  const stale = (await store.claim({
    owner,
    duration: 1000,
    knownTypes: ['counter'],
    excluded: [],
  }))!;
  const head = (await store.head(stale))!;
  await store.markRunning(stale, head, owner);
  await pool.query(`UPDATE ${schema}.actors SET lease_until=clock_timestamp()-interval '1 second'`);
  const current = (await store.claim({
    owner: randomUUID(),
    duration: 1000,
    knownTypes: ['counter'],
    excluded: [],
  }))!;
  expect(BigInt(current.fence)).toBeGreaterThan(BigInt(stale.fence));
  await expect(
    store.finish({
      actor: stale,
      head,
      owner,
      plan: {
        state: { n: 99 },
        result: 99,
        sends: [{ ...request, actorId: 'child', invocationId: 'brando:send:1:0' }],
        reminders: [
          {
            name: 'r',
            cancel: false,
            generation: 'brando:reminder:1:0',
            at: null,
            afterMs: 0,
            messageType: 'tick',
            payload: {},
          },
        ],
      },
    }),
  ).rejects.toBeInstanceOf(LeaseLost);
  expect((await store.find('parent'))?.status).toBe('RUNNING');
  expect((await pool.query(`SELECT * FROM ${schema}.actors`)).rows).toHaveLength(1);
  expect((await pool.query(`SELECT * FROM ${schema}.reminders`)).rows).toHaveLength(0);
});
it('preserves unknown state fields through an older definition', async () => {
  const store = new Store(pool, schema, 'test');
  await store.submit(
    envelope({
      registrations: registry([actor]),
      target: type.ref('a'),
      message: Add,
      payload: {},
    }),
    'one',
  );
  await pool.query(
    `UPDATE ${schema}.actors SET state='{"n":4,"newField":{"keep":true}}'::jsonb,revision=1`,
  );
  const runtime = await start();
  expect(await (await runtime.invocation({ id: 'one', result: Add.result }))!.await()).toBe(5);
  expect((await pool.query(`SELECT state FROM ${schema}.actors`)).rows[0].state).toEqual({
    n: 5,
    newField: { keep: true },
  });
});
it('caller timeout stops only the wait and shutdown recovers the accepted head', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const slow = defineActor({
    type,
    state,
    initial: () => ({ n: 0 }),
    handlers: (on) => [
      on(Add, async (ctx) => {
        attempts++;
        if (attempts === 1) await blocked;
        return ctx.update((s) => ({ n: s.n + 1 })).n;
      }),
    ],
  });
  const first = await start([slow], { gracefulShutdownMs: 30 });
  const invocation = await first.submit({ target: type.ref('a'), message: Add, payload: {} });
  await expect.poll(() => attempts).toBe(1);
  await expect(invocation.await({ timeoutMs: 10 })).rejects.toBeInstanceOf(WaitAborted);
  await first.close();
  const second = await start([slow]);
  expect(await (await second.invocation({ id: invocation.id, result: Add.result }))!.await()).toBe(
    1,
  );
  release();
  expect((await pool.query(`SELECT state,revision FROM ${schema}.actors`)).rows[0]).toMatchObject({
    state: { n: 1 },
    revision: '1',
  });
});
it('retention never deletes pending work and reusing a purged ID allocates a new incarnation', async () => {
  const store = new Store(pool, schema, 'test');
  const request = envelope({
    registrations: registry([actor]),
    target: type.ref('a'),
    message: Add,
    payload: {},
  });
  await store.submit(request, 'same');
  await store.submit(request, 'pending');
  const old = (await store.find('same'))!.incarnation;
  await pool.query(
    `UPDATE ${schema}.messages SET status='COMPLETED',completed_at=clock_timestamp()-interval '1 day' WHERE invocation_id='same'`,
  );
  expect(await store.retain({ ageMs: 1000, limit: 10 })).toBe(1);
  expect((await store.find('pending'))!.status).toBe('PENDING');
  await store.submit(request, 'same');
  expect((await store.find('same'))!.incarnation).not.toBe(old);
});
it('incompatible state stays nonterminal and a healthy definition recovers it', async () => {
  const store = new Store(pool, schema, 'test');
  await store.submit(
    envelope({
      registrations: registry([actor]),
      target: type.ref('a'),
      message: Add,
      payload: {},
    }),
    'bad-state',
  );
  await pool.query(`UPDATE ${schema}.actors SET state='{"n":"old"}'::jsonb,revision=1`);
  const old = await start();
  await expect.poll(async () => (await old.health()).incompatibleActors).toBe(1);
  expect((await store.find('bad-state'))?.status).toBe('RUNNING');
  await old.close();
  await pool.query(`UPDATE ${schema}.actors SET state='{"n":8}'::jsonb`);
  const healthy = await start();
  expect(await (await healthy.invocation({ id: 'bad-state', result: Add.result }))!.await()).toBe(
    9,
  );
});
it('unknown messages defer during grace and then fail without blocking the next message', async () => {
  const store = new Store(pool, schema, 'test');
  const request = envelope({
    registrations: registry([actor]),
    target: type.ref('a'),
    message: Add,
    payload: {},
  });
  await store.submit(request, 'unknown');
  await store.submit(request, 'next');
  await pool.query(
    `UPDATE ${schema}.messages SET message_type='future-message' WHERE invocation_id='unknown'`,
  );
  const runtime = await start([actor], { unknownMessageGraceMs: 2000 });
  await expect.poll(async () => (await runtime.health()).incompatibleActors).toBe(1);
  expect((await store.find('unknown'))!.status).toBe('PENDING');
  await pool.query(
    `UPDATE ${schema}.messages SET accepted_at=clock_timestamp()-interval '1 hour' WHERE invocation_id='unknown'`,
  );
  expect(
    await (await runtime.invocation({ id: 'next', result: Add.result }))!.await({
      timeoutMs: 5000,
    }),
  ).toBe(1);
  expect((await store.find('unknown'))!.failure?.category).toBe('message-decoding');
});
it('reminder materialization skips unknown types without starving known reminders', async () => {
  const store = new Store(pool, schema, 'test');
  const request = envelope({
    registrations: registry([actor]),
    target: type.ref('a'),
    message: Add,
    payload: {},
  });
  await store.submit(request, 'seed');
  const key = (await pool.query(`SELECT actor_key FROM ${schema}.actors`)).rows[0].actor_key;
  await pool.query(
    `INSERT INTO ${schema}.reminders(application,actor_type,actor_key,name,generation,due_at,message_type,payload)
    SELECT 'test','counter',$1,'unknown-'||n,'unknown-generation-'||n,clock_timestamp()-interval '1 hour','unknown','{}' FROM generate_series(1,100) n`,
    [key],
  );
  await pool.query(
    `INSERT INTO ${schema}.reminders VALUES('test','counter',$1,'known','brando:reminder:9000:0',clock_timestamp()-interval '1 minute','tick','{}')`,
    [key],
  );
  expect(await store.materialize(new Map([['counter', new Set(['tick'])]]))).toBe(1);
  expect((await store.find('brando:reminder:9000:0'))!.status).toBe('PENDING');
});
it('renews leases while suspended so a second replica cannot run the same actor', async () => {
  let release!: () => void;
  let attempts = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = defineActor({
    type,
    state,
    initial: () => ({ n: 0 }),
    handlers: (on) => [
      on(Add, async (ctx) => {
        attempts++;
        await gate;
        return ctx.update((s) => ({ n: s.n + 1 })).n;
      }),
    ],
  });
  const a = await start([slow], { leaseDurationMs: 150, leaseRenewalMs: 40 });
  const b = await start([slow], { leaseDurationMs: 150, leaseRenewalMs: 40 });
  const accepted = await a.submit({ target: type.ref('a'), message: Add, payload: {} });
  await expect.poll(() => attempts).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(attempts).toBe(1);
  release();
  expect(await accepted.await()).toBe(1);
  expect((await b.health()).metrics.runtimeErrors).toBe(0);
});
it('canonical object IDs resolve the same actor and application namespaces stay separate', async () => {
  const objectType = actorType({
    name: 'object',
    id: codec('object-id', z.object({ a: z.string(), b: z.string() })),
  });
  const objectActor = defineActor({
    type: objectType,
    state,
    initial: () => ({ n: 0 }),
    handlers: (on) => [on(Add, (ctx) => ctx.update((s) => ({ n: s.n + 1 })).n)],
  });
  const a = await Brando.start({
    name: 'a',
    database,
    actors: [objectActor],
    config: { schema, pollIntervalMs: 10 },
  });
  const b = await Brando.start({
    name: 'b',
    database,
    actors: [objectActor],
    config: { schema, pollIntervalMs: 10 },
  });
  runtimes.push(a, b);
  expect(
    await a.call({
      target: objectType.ref({ a: 'x', b: 'y' }),
      message: Add,
      payload: {},
      invocationId: 'same',
    }),
  ).toBe(1);
  expect(
    await a.call({ target: objectType.ref({ b: 'y', a: 'x' }), message: Add, payload: {} }),
  ).toBe(2);
  expect(
    await b.call({
      target: objectType.ref({ a: 'x', b: 'y' }),
      message: Add,
      payload: {},
      invocationId: 'same',
    }),
  ).toBe(1);
});
it('schema validation rejects newer versions and borrowed pools remain caller-owned', async () => {
  const runtime = await Brando.start({
    name: 'test',
    database: pool,
    actors: [actor],
    config: { schema, schemaManagement: 'validate-only' },
  });
  await runtime.close();
  expect((await pool.query('SELECT 1 AS n')).rows[0].n).toBe(1);
  await pool.query(`UPDATE ${schema}.schema_version SET version=999`);
  await expect(
    Brando.start({ name: 'test', database, actors: [actor], config: { schema } }),
  ).rejects.toThrow('Unsupported schema version');
});
it('recovers an accepted invocation after the owning process is killed', async () => {
  const { fork } = await import('node:child_process');
  const { EventEmitter } = await import('node:events');
  const store = new Store(pool, schema, 'test');
  await store.submit(
    envelope({
      registrations: registry([actor]),
      target: type.ref('a'),
      message: Add,
      payload: {},
    }),
    'crash',
  );
  const child = fork('tests/fixtures/crash-worker.ts', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, CRASH_SCHEMA: schema },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  const timeout = AbortSignal.timeout(10000);
  try {
    await EventEmitter.once(child, 'message', { signal: timeout });
    const exited = EventEmitter.once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = await start();
    expect(await (await recovered.invocation({ id: 'crash', result: Add.result }))!.await()).toBe(
      1,
    );
    expect((await store.find('crash'))!.attempt_count).toBe(2);
    expect((await pool.query(`SELECT state FROM ${schema}.actors`)).rows[0].state).toEqual({
      n: 1,
    });
    expect(stderr).toBe('');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
