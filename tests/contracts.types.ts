import { z } from 'zod';
import { actorType, codec, defineActor, message, unit, type Brando } from '../src/index.js';
const counters = actorType({ name: 'counter', id: codec('string', z.string()) });
const add = message({
  name: 'add',
  payload: z.object({ amount: z.number() }),
  result: codec('number', z.number()),
});
const tick = message({ name: 'tick', payload: z.object({}), result: unit });
const state = codec('state', z.object({ value: z.number() }));
export function compileContracts(runtime: Brando) {
  // @ts-expect-error Actor IDs must match their registered codec.
  counters.ref(1);
  // @ts-expect-error Message payloads are inferred from their schema.
  void runtime.call({ target: counters.ref('a'), message: add, payload: { amount: 'wrong' } });
  defineActor({
    type: counters,
    state,
    initial: () => ({ value: 0 }),
    handlers: (on) => [
      // @ts-expect-error Results must match the message result codec.
      on(add, () => 'wrong'),
      on(tick, (ctx) => {
        // @ts-expect-error Managed sends require a unit result.
        ctx.send({ target: counters.ref('a'), message: add, payload: { amount: 1 } });
      }),
    ],
  });
}
