import { z } from 'zod';
import { Brando, actorType, codec, defineActor, message } from '../../src/index.js';
const type = actorType({ name: 'counter', id: codec('string', z.string()) });
const Add = message({ name: 'add', payload: z.object({}), result: codec('number', z.number()) });
const actor = defineActor({
  type,
  state: codec('counter.v1', z.object({ n: z.number() })),
  initial: () => ({ n: 0 }),
  handlers: (on) => [
    on(Add, async (ctx) => {
      ctx.update(() => ({ n: 999 }));
      process.send?.({ started: true });
      await new Promise<void>(() => {});
      return ctx.state.n;
    }),
  ],
});
await Brando.start({
  name: 'test',
  database: process.env.TEST_DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando',
  actors: [actor],
  config: {
    schema: process.env.CRASH_SCHEMA!,
    workerCount: 1,
    leaseDurationMs: 250,
    leaseRenewalMs: 50,
    pollIntervalMs: 10,
  },
});
