import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Brando,
  actorContract,
  actorType,
  codec,
  defineActor,
  message,
  unit,
} from '../src/index.js';

const connection =
  process.env.TEST_DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando';
const type = actorType({ name: 'delivery', id: codec('delivery-id', z.string()) });
const state = codec('delivery-state', z.object({ total: z.number() }));
const Deliver = message({
  name: 'deliver',
  payload: z.object({ amount: z.number() }),
  result: unit,
});
const contract = actorContract({ type, state, messages: [Deliver] });
const actor = defineActor({
  type,
  state,
  initial: () => ({ total: 0 }),
  handlers: (on) => [
    on(Deliver, (ctx, p) => {
      ctx.update((s) => ({ total: s.total + p.amount }));
    }),
  ],
});
const runtimes: Brando[] = [];
let pool: Pool;
let schema: string;
beforeEach(() => {
  schema = `producer_${randomUUID().replaceAll('-', '')}`;
  pool = new Pool({
    connectionString: connection,
    max: 8,
    connectionTimeoutMillis: 2000,
    statement_timeout: 10000,
  });
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});
async function start(options: Partial<Parameters<typeof Brando.start>[0]> = {}) {
  const runtime = await Brando.start({
    name: 'producer-test',
    database: pool,
    actors: [],
    contracts: [contract],
    ...options,
    config: {
      schema,
      workerCount: 0,
      pollIntervalMs: 10,
      reminderIntervalMs: 10,
      ...options.config,
    },
  });
  runtimes.push(runtime);
  return runtime;
}

it('accepts and inspects work without claiming it, then a worker completes the same invocation', async () => {
  const client = await start();
  const accepted = await client.submit({
    target: type.ref('a'),
    message: Deliver,
    payload: { amount: 3 },
    invocationId: 'request-a',
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect((await client.inspectInvocation(accepted.id))?.status).toBe('PENDING');
  expect((await client.health()).metrics.attempts).toBe(0);
  expect(client.catalogue()[0]?.messages[0]?.name).toBe('deliver');
  await start({ actors: [actor], config: { workerCount: 1 } });
  await accepted.await({ timeoutMs: 3000 });
  expect((await client.inspectActor({ actorType: type.name, id: 'a' }))?.actor.state).toEqual({
    total: 3,
  });
  await client.close();
  expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
});

it('submits through the JSON/HTTP contract path without a handler', async () => {
  const client = await start();
  const id = await client.submitJson({
    actorType: type.name,
    id: 'json',
    messageType: Deliver.name,
    payload: { amount: 2 },
  });
  expect((await client.inspectInvocation(id))?.status).toBe('PENDING');
});

it('can send transactionally to a contract that this worker never consumes', async () => {
  const source = actorType({ name: 'source', id: codec('source-id', z.string()) });
  const Dispatch = message({
    name: 'dispatch',
    payload: z.object({ fail: z.boolean() }),
    result: unit,
  });
  const dispatcher = defineActor({
    type: source,
    state,
    initial: () => ({ total: 0 }),
    handlers: (on) => [
      on(Dispatch, (ctx, p) => {
        ctx.send({ target: type.ref('target'), message: Deliver, payload: { amount: 7 } });
        if (p.fail) throw new Error('rollback');
      }),
    ],
  });
  const worker = await start({ actors: [dispatcher], config: { workerCount: 1 } });
  await expect(
    worker.call({
      target: source.ref('one'),
      message: Dispatch,
      payload: { fail: true },
      timeoutMs: 3000,
    }),
  ).rejects.toThrow('rollback');
  expect(await worker.inspectActor({ actorType: type.name, id: 'target' })).toBeNull();
  await worker.call({
    target: source.ref('one'),
    message: Dispatch,
    payload: { fail: false },
    timeoutMs: 3000,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect((await worker.invocations({ actorType: type.name }))[0]?.status).toBe('PENDING');
  await start({ actors: [actor], config: { workerCount: 1 } });
  await expect
    .poll(
      async () => (await worker.inspectActor({ actorType: type.name, id: 'target' }))?.actor.state,
    )
    .toEqual({ total: 7 });
});

it('rejects conflicting declarations and workers without executable actors', async () => {
  const wrong = actorContract({
    type,
    state: codec('incompatible-state', z.object({})),
    messages: [Deliver],
  });
  await expect(start({ actors: [actor], contracts: [wrong] })).rejects.toThrow(
    'Conflicting contract',
  );
  await expect(start({ config: { workerCount: 1 } })).rejects.toThrow('Executable actors');
});

it('does not run supplied actors or retention while configured as a client', async () => {
  const client = await start({
    actors: [actor],
    config: { terminalRetentionMs: 1, retentionIntervalMs: 10 },
  });
  const accepted = await client.submit({
    target: type.ref('idle'),
    message: Deliver,
    payload: { amount: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect((await client.inspectInvocation(accepted.id))?.status).toBe('PENDING');
  expect((await client.health()).metrics).toMatchObject({ attempts: 0, reminders: 0, purged: 0 });
});

it('preserves contract validation, duplicate identity, and result recovery on a client', async () => {
  const client = await start();
  const request = {
    target: type.ref('duplicate'),
    message: Deliver,
    payload: { amount: 1 },
    invocationId: 'duplicate',
  };
  await client.submit(request);
  expect((await client.submit(request)).id).toBe('duplicate');
  await expect(client.submit({ ...request, payload: { amount: 2 } })).rejects.toThrow(
    'different request',
  );
  await expect(
    client.submitJson({
      actorType: type.name,
      id: 'invalid',
      messageType: Deliver.name,
      payload: { amount: 'bad' },
    }),
  ).rejects.toThrow();
  await start({ actors: [actor], config: { workerCount: 1 } });
  await expect(
    (await client.invocation({ id: 'duplicate', result: unit }))!.await({ timeoutMs: 3000 }),
  ).resolves.toBeUndefined();
});
