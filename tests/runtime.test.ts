import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Brando,
  ActorInvocationFailed,
  InvocationIdConflict,
  actorType,
  codec,
  defineActor,
  message,
  unit,
} from '../src/index.js';

const database = process.env.TEST_DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando';
const type = actorType({ name: 'counter', id: codec('string', z.string()) });
const Add = message({
  name: 'add',
  payload: z.object({ amount: z.number() }),
  result: codec('number', z.number()),
});
const Get = message({ name: 'get', payload: z.object({}), result: codec('number', z.number()) });
const Tick = message({ name: 'tick', payload: z.object({ amount: z.number() }), result: unit });
const Effects = message({
  name: 'effects',
  payload: z.object({ fail: z.boolean() }),
  result: unit,
});
const counter = defineActor({
  type,
  state: codec('counter.v1', z.object({ value: z.number() })),
  initial: () => ({ value: 0 }),
  handlers: (on) => [
    on(Add, (ctx, p) => ctx.update((s) => ({ value: s.value + p.amount })).value),
    on(Get, (ctx) => ctx.state.value),
    on(Tick, (ctx, p) => {
      ctx.update((s) => ({ value: s.value + p.amount }));
    }),
    on(Effects, (ctx, p) => {
      ctx.update((s) => ({ value: s.value + 1 }));
      ctx.send({ target: type.ref('child'), message: Tick, payload: { amount: 7 } });
      ctx.remind({ name: 'wake', afterMs: 50, message: Tick, payload: { amount: 3 } });
      if (p.fail) throw new Error('expected failure');
    }),
  ],
});
let schema: string;
let pool: Pool;
let runtimes: Brando[];
async function start(overrides: Partial<Parameters<typeof Brando.start>[0]> = {}) {
  const runtime = await Brando.start({
    name: 'tests',
    database,
    actors: [counter],
    config: {
      schema,
      pollIntervalMs: 10,
      reminderIntervalMs: 10,
      leaseDurationMs: 1000,
      leaseRenewalMs: 200,
      workerCount: 2,
    },
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}
beforeEach(() => {
  schema = `test_${randomUUID().replaceAll('-', '')}`;
  pool = new Pool({ connectionString: database });
  runtimes = [];
});
afterEach(async () => {
  await Promise.all(runtimes.map((r) => r.close()));
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});
describe('PostgreSQL conformance', () => {
  it('durably accepts, deduplicates, rejects conflicting IDs and resumes results', async () => {
    const runtime = await start();
    const request = {
      target: type.ref('a'),
      message: Add,
      payload: { amount: 2 },
      invocationId: 'stable',
    };
    const [a, b] = await Promise.all([runtime.submit(request), runtime.submit(request)]);
    expect(await a.await()).toBe(2);
    expect(await b.await()).toBe(2);
    await expect(runtime.submit({ ...request, payload: { amount: 3 } })).rejects.toBeInstanceOf(
      InvocationIdConflict,
    );
    await runtime.close();
    const restarted = await start();
    expect(await (await restarted.invocation({ id: 'stable', result: Add.result }))?.await()).toBe(
      2,
    );
    expect(await restarted.call({ target: type.ref('a'), message: Get, payload: {} })).toBe(2);
  });
  it('serializes mailbox order across replicas', async () => {
    const a = await start();
    const b = await start();
    const accepted = [];
    for (let i = 0; i < 20; i++)
      accepted.push(
        await (i % 2 ? a : b).submit({
          target: type.ref('a'),
          message: Add,
          payload: { amount: 1 },
        }),
      );
    expect(await Promise.all(accepted.map((i) => i.await()))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
  it('rolls back failed state/effects and lets the next head run', async () => {
    const runtime = await start();
    await expect(
      runtime.call({ target: type.ref('a'), message: Effects, payload: { fail: true } }),
    ).rejects.toBeInstanceOf(ActorInvocationFailed);
    expect(await runtime.call({ target: type.ref('a'), message: Get, payload: {} })).toBe(0);
    expect(
      (await pool.query(`SELECT * FROM ${schema}.actors WHERE actor_id = '"child"'::jsonb`))
        .rowCount,
    ).toBe(0);
    expect((await pool.query(`SELECT * FROM ${schema}.reminders`)).rowCount).toBe(0);
  });
  it('atomically sends and materializes reminders once', async () => {
    const runtime = await start();
    await runtime.call({ target: type.ref('a'), message: Effects, payload: { fail: false } });
    await expect
      .poll(async () => runtime.call({ target: type.ref('a'), message: Get, payload: {} }))
      .toBe(4);
    expect(await runtime.call({ target: type.ref('child'), message: Get, payload: {} })).toBe(7);
    expect(
      (
        await pool.query(
          `SELECT count(*) FROM ${schema}.messages WHERE invocation_id LIKE 'brando:reminder:%'`,
        )
      ).rows[0].count,
    ).toBe('1');
  });
});
