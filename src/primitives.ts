import { z } from 'zod';
import { codec, defineActor, message, unit } from './model.js';
import type { ActorType, HandlerScope } from './model.js';

const empty = z.object({});
const integer = z.number().int().safe();
const bucket = codec(
  'brando.primitives.ratelimit.bucket.v1',
  z.object({
    capacity: integer,
    tokens: integer,
    refillMillis: integer,
    refillArmed: z.boolean(),
    granted: integer,
    rejected: integer,
    configured: z.boolean(),
  }),
);
export const ConfigureBucket = message({
  name: 'brando.primitives.ratelimit.configure.v1',
  payload: z.object({ capacity: integer, refillMillis: integer }),
  result: unit,
});
export const Acquire = message({
  name: 'brando.primitives.ratelimit.acquire.v1',
  payload: empty,
  result: codec(
    'brando.primitives.ratelimit.acquire-result.v1',
    z.discriminatedUnion('granted', [
      z.object({ granted: z.literal(true), remaining: integer }),
      z.object({ granted: z.literal(false), retryAfterMillis: integer }),
    ]),
  ),
});
export const RefillTick = message({
  name: 'brando.primitives.ratelimit.refill.v1',
  payload: empty,
  result: unit,
});
export const ReadBucket = message({
  name: 'brando.primitives.ratelimit.read.v1',
  payload: empty,
  result: bucket,
});
export function rateLimiter<I>({
  type,
  capacity,
  refillMs,
}: {
  type: ActorType<I>;
  capacity: number;
  refillMs: number;
}) {
  z.number().int().positive().parse(capacity);
  integer.parse(refillMs);
  return defineActor({
    type,
    state: bucket,
    initial: () => ({
      capacity: 0,
      tokens: 0,
      refillMillis: 0,
      refillArmed: false,
      granted: 0,
      rejected: 0,
      configured: false,
    }),
    handlers: (on) => [
      on(ConfigureBucket, (ctx, p) => {
        ctx.update((s) => ({
          ...s,
          capacity: p.capacity,
          tokens: p.capacity,
          refillMillis: p.refillMillis,
          configured: true,
        }));
      }),
      on(Acquire, (ctx) => {
        const current = ctx.state.configured
          ? ctx.state
          : { ...ctx.state, capacity, tokens: capacity, refillMillis: refillMs, configured: true };
        if (current.tokens > 0) {
          const next = ctx.update(() => ({
            ...current,
            tokens: current.tokens - 1,
            granted: current.granted + 1,
          }));
          if (!next.refillArmed) {
            ctx.update((s) => ({ ...s, refillArmed: true }));
            ctx.remind({
              name: 'refill',
              afterMs: next.refillMillis,
              message: RefillTick,
              payload: {},
            });
          }
          return { granted: true as const, remaining: next.tokens };
        }
        ctx.update(() => ({ ...current, rejected: current.rejected + 1 }));
        return { granted: false as const, retryAfterMillis: current.refillMillis };
      }),
      on(RefillTick, (ctx) => {
        ctx.update((s) => ({ ...s, tokens: s.capacity, refillArmed: false }));
      }),
      on(ReadBucket, (ctx) => ctx.state),
    ],
  });
}
const schedule = codec(
  'brando.primitives.schedule.state.v1',
  z.object({
    enabled: z.boolean(),
    generation: integer,
    cadenceMillis: integer,
    completedTicks: integer,
  }),
);
export type ScheduleState = ReturnType<typeof schedule.decode>;
export const StartSchedule = message({
  name: 'brando.primitives.schedule.start.v1',
  payload: z.object({ cadenceMillis: integer }),
  result: unit,
});
export const StopSchedule = message({
  name: 'brando.primitives.schedule.stop.v1',
  payload: empty,
  result: unit,
});
export const ScheduleTick = message({
  name: 'brando.primitives.schedule.tick.v1',
  payload: z.object({ generation: integer }),
  result: unit,
});
export const ReadSchedule = message({
  name: 'brando.primitives.schedule.read.v1',
  payload: empty,
  result: schedule,
});
export function recurringSchedule<I>({
  type,
  onOccurrence,
}: {
  type: ActorType<I>;
  onOccurrence: (options: {
    scope: HandlerScope<I, ScheduleState>;
    occurrence: number;
  }) => void | Promise<void>;
}) {
  return defineActor({
    type,
    state: schedule,
    initial: () => ({ enabled: false, generation: 0, cadenceMillis: 0, completedTicks: 0 }),
    handlers: (on) => [
      on(StartSchedule, (ctx, p) => {
        const next = ctx.update((s) => ({
          ...s,
          enabled: true,
          generation: s.generation + 1,
          cadenceMillis: p.cadenceMillis,
        }));
        ctx.remind({
          name: 'tick',
          afterMs: p.cadenceMillis,
          message: ScheduleTick,
          payload: { generation: next.generation },
        });
      }),
      on(StopSchedule, (ctx) => {
        ctx.update((s) => ({ ...s, enabled: false, generation: s.generation + 1 }));
        ctx.cancelReminder('tick');
      }),
      on(ScheduleTick, async (ctx, p) => {
        if (!ctx.state.enabled || ctx.state.generation !== p.generation) return;
        const next = ctx.update((s) => ({ ...s, completedTicks: s.completedTicks + 1 }));
        await onOccurrence({ scope: ctx, occurrence: next.completedTicks });
        ctx.remind({
          name: 'tick',
          afterMs: ctx.state.cadenceMillis,
          message: ScheduleTick,
          payload: p,
        });
      }),
      on(ReadSchedule, (ctx) => ctx.state),
    ],
  });
}
const retry = codec(
  'brando.primitives.retry.state.v1',
  z.object({
    status: z.enum(['New', 'Running', 'Succeeded', 'GaveUp']),
    generation: integer,
    providerKey: z.string().nullable(),
    payload: z.string(),
    attemptsMade: integer,
    nextDelayMillis: integer,
    maxAttempts: integer,
  }),
);
export type RetryState = ReturnType<typeof retry.decode>;
export const StartRetry = message({
  name: 'brando.primitives.retry.start.v1',
  payload: z.object({
    payload: z.string(),
    initialDelayMillis: integer.default(50),
    maxAttempts: integer.default(5),
  }),
  result: unit,
});
export const RetryTick = message({
  name: 'brando.primitives.retry.tick.v1',
  payload: z.object({ generation: integer, expectedAttempt: integer }),
  result: unit,
});
export const ReadRetry = message({
  name: 'brando.primitives.retry.read.v1',
  payload: empty,
  result: retry,
});
export function retryRunner<I>({
  type,
  operation,
}: {
  type: ActorType<I>;
  operation: (options: {
    providerKey: string;
    payload: string;
    attempt: number;
    signal: AbortSignal;
  }) => 'success' | 'retry' | Promise<'success' | 'retry'>;
}) {
  async function attempt(ctx: HandlerScope<I, RetryState>) {
    const current = ctx.state;
    const n = current.attemptsMade + 1;
    const outcome = await operation({
      providerKey: current.providerKey!,
      payload: current.payload,
      attempt: n,
      signal: ctx.signal,
    });
    if (outcome === 'success') ctx.update((s) => ({ ...s, status: 'Succeeded', attemptsMade: n }));
    else if (n >= current.maxAttempts)
      ctx.update((s) => ({ ...s, status: 'GaveUp', attemptsMade: n }));
    else {
      ctx.update((s) => ({ ...s, attemptsMade: n, nextDelayMillis: current.nextDelayMillis * 2 }));
      ctx.remind({
        name: 'retry',
        afterMs: current.nextDelayMillis,
        message: RetryTick,
        payload: { generation: current.generation, expectedAttempt: n + 1 },
      });
    }
  }
  return defineActor({
    type,
    state: retry,
    initial: (): RetryState => ({
      status: 'New',
      generation: 0,
      providerKey: null,
      payload: '',
      attemptsMade: 0,
      nextDelayMillis: 0,
      maxAttempts: 0,
    }),
    handlers: (on) => [
      on(StartRetry, async (ctx, p) => {
        if (ctx.state.status !== 'New') return;
        ctx.update((s) => ({
          ...s,
          status: 'Running',
          generation: s.generation + 1,
          providerKey: ctx.idempotencyKey('retry-operation'),
          payload: p.payload,
          attemptsMade: 0,
          nextDelayMillis: p.initialDelayMillis,
          maxAttempts: p.maxAttempts,
        }));
        await attempt(ctx);
      }),
      on(RetryTick, async (ctx, p) => {
        if (
          ctx.state.status === 'Running' &&
          ctx.state.generation === p.generation &&
          p.expectedAttempt === ctx.state.attemptsMade + 1
        )
          await attempt(ctx);
      }),
      on(ReadRetry, (ctx) => ctx.state),
    ],
  });
}
const monitor = codec(
  'brando.primitives.monitor.state.v1',
  z.object({ generation: integer, alertOpen: z.boolean(), pulses: integer }),
);
export type MonitorState = ReturnType<typeof monitor.decode>;
export const Pulse = message({
  name: 'brando.primitives.monitor.pulse.v1',
  payload: z.object({ allowedSilenceMillis: integer }),
  result: unit,
});
export const SilenceCheck = message({
  name: 'brando.primitives.monitor.silence-check.v1',
  payload: z.object({ generation: integer }),
  result: unit,
});
export const ReadMonitor = message({
  name: 'brando.primitives.monitor.read.v1',
  payload: empty,
  result: monitor,
});
export function heartbeatMonitor<I>({
  type,
  onAlert,
  onResolution,
}: {
  type: ActorType<I>;
  onAlert: (options: {
    scope: HandlerScope<I, MonitorState>;
    generation: number;
  }) => void | Promise<void>;
  onResolution: (options: {
    scope: HandlerScope<I, MonitorState>;
    generation: number;
  }) => void | Promise<void>;
}) {
  return defineActor({
    type,
    state: monitor,
    initial: () => ({ generation: 0, alertOpen: false, pulses: 0 }),
    handlers: (on) => [
      on(Pulse, async (ctx, p) => {
        const resolve = ctx.state.alertOpen;
        const next = ctx.update((s) => ({
          ...s,
          generation: s.generation + 1,
          alertOpen: false,
          pulses: s.pulses + 1,
        }));
        ctx.remind({
          name: 'silence',
          afterMs: p.allowedSilenceMillis,
          message: SilenceCheck,
          payload: { generation: next.generation },
        });
        if (resolve) await onResolution({ scope: ctx, generation: next.generation });
      }),
      on(SilenceCheck, async (ctx, p) => {
        if (ctx.state.generation === p.generation && !ctx.state.alertOpen) {
          ctx.update((s) => ({ ...s, alertOpen: true }));
          await onAlert({ scope: ctx, generation: p.generation });
        }
      }),
      on(ReadMonitor, (ctx) => ctx.state),
    ],
  });
}
