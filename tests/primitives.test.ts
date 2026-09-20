import { expect, it } from 'vitest';
import { z } from 'zod';
import { actorType, codec } from '../src/index.js';
import { actorTurnTest } from '../src/testing.js';
import {
  Acquire,
  rateLimiter,
  recurringSchedule,
  ScheduleTick,
  StopSchedule,
  retryRunner,
  StartRetry,
  RetryTick,
  heartbeatMonitor,
  Pulse,
  SilenceCheck,
} from '../src/primitives.js';
const type = actorType({ name: 'primitive', id: codec('string', z.string()) });
it('rate limiter never grants beyond capacity and arms one refill', async () => {
  const actor = rateLimiter({ type, capacity: 1, refillMs: 100 });
  const first = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: Acquire,
    payload: {},
  });
  expect(first.result).toEqual({ granted: true, remaining: 0 });
  expect(first.reminders).toHaveLength(1);
  const second = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    state: first.state,
    message: Acquire,
    payload: {},
  });
  expect(second.result).toEqual({ granted: false, retryAfterMillis: 100 });
  expect(second.reminders).toHaveLength(0);
});
it('stopped schedules ignore a materialized stale tick', async () => {
  let effects = 0;
  const actor = recurringSchedule({
    type,
    onOccurrence: () => {
      effects++;
    },
  });
  const stop = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: StopSchedule,
    payload: {},
    state: { enabled: true, generation: 1, cadenceMillis: 10, completedTicks: 0 },
  });
  const tick = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: ScheduleTick,
    payload: { generation: 1 },
    state: stop.state,
  });
  expect(effects).toBe(0);
  expect(tick.reminders).toHaveLength(0);
});
it('retry runner persists one provider key and doubles backoff', async () => {
  const keys: string[] = [];
  const actor = retryRunner({
    type,
    operation: async ({ providerKey }) => {
      keys.push(providerKey);
      return 'retry' as const;
    },
  });
  const first = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: StartRetry,
    payload: { payload: 'job', initialDelayMillis: 50, maxAttempts: 3 },
  });
  const second = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: RetryTick,
    payload: { generation: 1, expectedAttempt: 2 },
    state: first.state,
  });
  expect(keys[0]).toBe(keys[1]);
  expect(second.state.nextDelayMillis).toBe(200);
  expect(second.reminders[0]).toMatchObject({ afterMs: 100 });
  const third = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: RetryTick,
    payload: { generation: 1, expectedAttempt: 3 },
    state: second.state,
  });
  expect(third.state.status).toBe('GaveUp');
  expect(third.reminders).toHaveLength(0);
});
it('monitor ignores old generations and resolves an open alert on pulse', async () => {
  const transitions: string[] = [];
  const actor = heartbeatMonitor({
    type,
    onAlert: () => {
      transitions.push('alert');
    },
    onResolution: () => {
      transitions.push('resolved');
    },
  });
  const pulse = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    message: Pulse,
    payload: { allowedSilenceMillis: 100 },
  });
  const stale = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    state: pulse.state,
    message: SilenceCheck,
    payload: { generation: 0 },
  });
  expect(stale.state.alertOpen).toBe(false);
  const alert = await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    state: pulse.state,
    message: SilenceCheck,
    payload: { generation: 1 },
  });
  await actorTurnTest({
    actors: [actor],
    actor,
    id: 'a',
    state: alert.state,
    message: Pulse,
    payload: { allowedSilenceMillis: 100 },
  });
  expect(transitions).toEqual(['alert', 'resolved']);
});
