import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { z } from 'zod';
import { actorType, codec, defineActor, message, Brando } from '../src/index.js';
import { createOperationsHandler } from '../src/http.js';
const type = actorType({ name: 'http', id: codec('string', z.string()) });
const Get = message({ name: 'get', payload: z.object({}), result: codec('number', z.number()) });
let runtime: Brando;
let handle: ReturnType<typeof createOperationsHandler>;
const database = process.env.TEST_DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando';
const schema = `http_${Date.now()}`;
beforeAll(async () => {
  runtime = await Brando.start({
    name: 'http-test',
    database,
    config: { schema, pollIntervalMs: 10 },
    actors: [
      defineActor({
        type,
        state: codec('state', z.object({ n: z.number() })),
        initial: () => ({ n: 1 }),
        handlers: (on) => [on(Get, (ctx) => ctx.state.n)],
      }),
    ],
  });
  handle = createOperationsHandler({
    runtime,
    authorize: (request) =>
      request.headers.get('authorization') === 'Bearer write'
        ? 'write'
        : request.headers.get('authorization') === 'Bearer read'
          ? 'read'
          : false,
  });
});
afterAll(async () => {
  await runtime?.close();
  const pool = new Pool({ connectionString: database });
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});
it('requires authorization and rejects read-only mutations', async () => {
  expect((await handle(new Request('http://localhost/api/brando/overview'))).status).toBe(401);
  expect(
    (
      await handle(
        new Request('http://localhost/api/brando/submit', {
          method: 'POST',
          headers: { authorization: 'Bearer read' },
        }),
      )
    ).status,
  ).toBe(403);
});
it('rejects cross-origin mutations and oversized bodies', async () => {
  expect(
    (
      await handle(
        new Request('http://localhost/api/brando/submit', {
          method: 'POST',
          headers: {
            authorization: 'Bearer write',
            origin: 'http://evil.invalid',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handle(
        new Request('http://localhost/api/brando/submit', {
          method: 'POST',
          headers: { authorization: 'Bearer write', 'content-type': 'application/json' },
          body: 'x'.repeat(1_048_577),
        }),
      )
    ).status,
  ).toBe(413);
});
it('validates input, submits, inspects and bounds lists', async () => {
  const headers = { authorization: 'Bearer write', 'content-type': 'application/json' };
  const bad = await handle(
    new Request('http://localhost/api/brando/submit', { method: 'POST', headers, body: '{' }),
  );
  expect(bad.status).toBe(400);
  const response = await handle(
    new Request('http://localhost/api/brando/submit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ actorType: 'http', id: 'a', messageType: 'get', payload: {} }),
    }),
  );
  expect(response.status).toBe(202);
  const body = (await response.json()) as { invocationId: string };
  expect(body.invocationId).toBeTruthy();
  const read = await handle(
    new Request(`http://localhost/api/brando/invocations/${body.invocationId}`, { headers }),
  );
  expect(read.status).toBe(200);
  expect(
    (await handle(new Request('http://localhost/api/brando/actors?limit=-1', { headers }))).status,
  ).toBe(400);
});
