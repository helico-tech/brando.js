import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { actorType, codec, defineActor, message, unit } from '../src/index.js';
import { actorTurnTest } from '../src/testing.js';

const type = actorType({ name: 'counter', id: codec('string', z.string()) });
const Add = message({
  name: 'add',
  payload: z.object({ amount: z.number() }),
  result: codec('number', z.number()),
});
const Notify = message({ name: 'notify', payload: z.object({}), result: unit });
const Mutate = message({ name: 'mutate', payload: z.object({ fail: z.boolean() }), result: unit });
const counter = defineActor({
  type,
  state: codec('counter.v1', z.object({ value: z.number() })),
  initial: () => ({ value: 0 }),
  handlers: (on) => [
    on(Add, (ctx, payload) => ctx.update((s) => ({ value: s.value + payload.amount })).value),
    on(Notify, (ctx) => {
      ctx.update((s) => ({ value: s.value + 1 }));
    }),
    on(Mutate, (ctx, payload) => {
      ctx.state.value = 99;
      ctx.send({ target: type.ref('child'), message: Notify, payload: {} });
      ctx.remind({ name: 'tick', afterMs: 100, message: Notify, payload: {} });
      if (payload.fail) throw new Error('rollback');
    }),
  ],
});
describe('production turn kernel', () => {
  it('updates state and returns the typed result', async () => {
    const turn = await actorTurnTest({
      actors: [counter],
      actor: counter,
      id: 'a',
      state: { value: 4 },
      message: Add,
      payload: { amount: 3 },
    });
    expect(turn.state).toEqual({ value: 7 });
    expect(turn.result).toBe(7);
  });
  it('discards direct mutations without update but commits effects', async () => {
    const turn = await actorTurnTest({
      actors: [counter],
      actor: counter,
      id: 'a',
      state: { value: 4 },
      message: Mutate,
      payload: { fail: false },
      incarnation: '17',
    });
    expect(turn.state).toEqual({ value: 4 });
    expect(turn.sends[0]?.invocationId).toBe('brando:send:17:0');
    expect(turn.reminders[0]).toMatchObject({ name: 'tick', generation: 'brando:reminder:17:0' });
  });
  it('throws on failure without leaking changes into the supplied state', async () => {
    const state = { value: 4 };
    await expect(
      actorTurnTest({
        actors: [counter],
        actor: counter,
        id: 'a',
        state,
        message: Mutate,
        payload: { fail: true },
      }),
    ).rejects.toThrow('rollback');
    expect(state).toEqual({ value: 4 });
  });
  it('rejects non-JSON data rather than silently losing it', () => {
    expect(() => codec('bad', z.any()).encode({ count: Number.NaN })).toThrow();
    expect(() => codec('bad', z.any()).encode({ missing: undefined })).toThrow();
  });
});
it('seals escaped scopes and keeps stable idempotency keys across attempts', async () => {
  let escaped: import('../src/index.js').HandlerScope<string, { value: number }> | undefined;
  const keys: string[] = [];
  const actor = defineActor({
    type,
    state: codec('counter.v1', z.object({ value: z.number() })),
    initial: () => ({ value: 0 }),
    handlers: (on) => [
      on(Notify, (ctx) => {
        escaped = ctx;
        keys.push(ctx.idempotencyKey('provider'));
      }),
    ],
  });
  const options = {
    actors: [actor],
    actor,
    id: 'a',
    message: Notify,
    payload: {},
    invocationId: 'stable',
  };
  await actorTurnTest(options);
  await actorTurnTest(options);
  expect(keys[0]).toBe(keys[1]);
  expect(() => escaped!.update((s) => s)).toThrow('sealed');
});
it('uses last reminder operation and rejects invalid effect contracts atomically', async () => {
  const actor = defineActor({
    type,
    state: codec('counter.v1', z.object({ value: z.number() })),
    initial: () => ({ value: 0 }),
    handlers: (on) => [
      on(Notify, (ctx) => {
        ctx.remind({ name: 'tick', afterMs: 10, message: Notify, payload: {} });
        ctx.cancelReminder('tick');
        ctx.remind({ name: 'tick', afterMs: 20, message: Notify, payload: {} });
      }),
    ],
  });
  const turn = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: Notify,
    payload: {},
    incarnation: '5',
  });
  expect(turn.reminders).toEqual([
    expect.objectContaining({ afterMs: 20, generation: 'brando:reminder:5:1' }),
  ]);
  const invalid = defineActor({
    type,
    state: actor.state,
    initial: () => ({ value: 0 }),
    handlers: (on) => [
      on(Notify, (ctx) => {
        ctx.send({
          target: actorType({ name: 'unregistered', id: type.id }).ref('b'),
          message: Notify,
          payload: {},
        });
      }),
    ],
  });
  await expect(
    actorTurnTest({ actors: [invalid], actor: invalid, id: 'a', message: Notify, payload: {} }),
  ).rejects.toThrow('send-contract');
});
it('distinguishes a committed null state from an uninitialized actor', async () => {
  let initializations = 0;
  const actor = defineActor({
    type,
    state: codec('nullable.v1', z.null()),
    initial: () => {
      initializations++;
      return null;
    },
    handlers: (on) => [on(Notify, () => {})],
  });
  await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    state: null,
    message: Notify,
    payload: {},
  });
  expect(initializations).toBe(0);
});
