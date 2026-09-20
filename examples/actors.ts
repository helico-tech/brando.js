import { z } from 'zod';
import { actorType, codec, defineActor, message, unit } from '../src/index.js';
import {
  recurringSchedule,
  heartbeatMonitor,
  rateLimiter,
  retryRunner,
} from '../src/primitives.js';
export const Counters = actorType({ name: 'counter', id: codec('string', z.string()) });
export const Add = message({
  name: 'counter.add',
  payload: z.object({ amount: z.number() }),
  result: codec('number', z.number()),
});
export const Read = message({
  name: 'counter.read',
  payload: z.object({}),
  result: codec('number', z.number()),
});
export const Increment = message({
  name: 'counter.increment',
  payload: z.object({ amount: z.number() }),
  result: unit,
});
export const Schedule = message({
  name: 'counter.schedule',
  payload: z.object({ afterMs: z.number(), amount: z.number() }),
  result: unit,
});
export const Fail = message({
  name: 'counter.fail',
  payload: z.object({ reason: z.string() }),
  result: unit,
});
export const counter = defineActor({
  type: Counters,
  state: codec('counter.state.v1', z.object({ value: z.number() })),
  initial: () => ({ value: 0 }),
  handlers: (on) => [
    on(Add, (ctx, p) => ctx.update((s) => ({ value: s.value + p.amount })).value),
    on(Read, (ctx) => ctx.state.value),
    on(Increment, (ctx, p) => {
      ctx.update((s) => ({ value: s.value + p.amount }));
    }),
    on(Schedule, (ctx, p) => {
      ctx.remind({
        name: 'increment',
        afterMs: p.afterMs,
        message: Increment,
        payload: { amount: p.amount },
      });
    }),
    on(Fail, (_ctx, p) => {
      throw new Error(p.reason);
    }),
  ],
});
export const Jobs = actorType({ name: 'schedule', id: codec('string', z.string()) });
export const Monitors = actorType({ name: 'heartbeat', id: codec('string', z.string()) });
export const Limits = actorType({ name: 'rate-limit', id: codec('string', z.string()) });
export const Retries = actorType({ name: 'retry', id: codec('string', z.string()) });
export const actors = [
  counter,
  recurringSchedule({
    type: Jobs,
    onOccurrence: ({ scope }) => {
      scope.send({
        target: Counters.ref('scheduled-events'),
        message: Increment,
        payload: { amount: 1 },
      });
    },
  }),
  heartbeatMonitor({
    type: Monitors,
    onAlert: ({ scope }) => {
      scope.send({ target: Counters.ref('alerts'), message: Increment, payload: { amount: 1 } });
    },
    onResolution: ({ scope }) => {
      scope.send({
        target: Counters.ref('resolutions'),
        message: Increment,
        payload: { amount: 1 },
      });
    },
  }),
  rateLimiter({ type: Limits, capacity: 10, refillMs: 60000 }),
  retryRunner({ type: Retries, operation: ({ attempt }) => (attempt >= 3 ? 'success' : 'retry') }),
];
