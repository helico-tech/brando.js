import {
  ActorInvocationFailed,
  BrandoError,
  RegistrationError,
  StateIncompatible,
  canonical,
  durableName,
  idempotencyKey,
  unit,
} from './model.js';
import type {
  ActorRef,
  ContractRegistration,
  Failure,
  HandlerScope,
  Json,
  Message,
  Registration,
  Reminder,
  Send,
} from './model.js';

export interface Envelope {
  actorType: string;
  actorId: Json;
  actorKey: string;
  idType: string;
  stateType: string;
  messageType: string;
  resultType: string;
  payload: Json;
}
export interface PlannedSend extends Envelope {
  invocationId: string;
}
export type PlannedReminder =
  | { name: string; cancel: true }
  | {
      name: string;
      cancel: false;
      generation: string;
      at: string | null;
      afterMs: number | null;
      messageType: string;
      payload: Json;
    };
export interface TurnPlan {
  state: Json;
  result: Json;
  sends: PlannedSend[];
  reminders: PlannedReminder[];
}
export function envelope<I, P, R>({
  registrations,
  target,
  message,
  payload,
}: {
  registrations: Map<string, ContractRegistration>;
  target: ActorRef<I>;
  message: Message<P, R>;
  payload: P;
}): Envelope {
  const actor = registrations.get(target.type.name);
  if (!actor || actor.type.id.name !== target.type.id.name)
    throw new RegistrationError(`Unregistered actor identity ${target.type.name}`);
  if (actor.messages.get(message.name) !== message)
    throw new RegistrationError(`Unregistered message ${message.name} for ${target.type.name}`);
  const actorId = actor.type.id.encode(target.id);
  return {
    actorType: actor.type.name,
    actorId,
    actorKey: canonical(actorId),
    idType: actor.type.id.name,
    stateType: actor.state.name,
    messageType: message.name,
    resultType: message.result.name,
    payload: message.payload.encode(payload),
  };
}
export function failure(cause: unknown, category = 'application'): Failure {
  return {
    category,
    name: (cause instanceof Error ? cause.name : 'Error').slice(0, 200),
    message: (cause instanceof Error ? cause.message : String(cause))
      .replaceAll('\0', '')
      .toWellFormed()
      .slice(0, 2000),
  };
}
export async function executeTurn(options: {
  application: string;
  registrations: Map<string, Registration>;
  contracts?: Map<string, ContractRegistration>;
  actor: Registration;
  actorId: Json;
  invocationId: string;
  incarnation: string;
  state: Json | null;
  hasState?: boolean;
  messageType: string;
  resultType: string;
  payload: Json;
  signal: AbortSignal;
}): Promise<TurnPlan> {
  const { actor, signal } = options;
  const handler = actor.handlers.get(options.messageType);
  let baseline: Json;
  let state: unknown;
  let id: unknown;
  try {
    id = actor.type.id.decode(options.actorId);
  } catch (cause) {
    throw new StateIncompatible('Actor ID cannot decode', { cause });
  }
  if (options.state !== null || options.hasState) {
    baseline = options.state;
    try {
      state = actor.state.decode(baseline);
    } catch (cause) {
      throw new StateIncompatible('Committed actor state cannot decode', { cause });
    }
  } else {
    try {
      baseline = actor.state.encode(actor.initial(id));
      state = actor.state.decode(baseline);
    } catch (cause) {
      throw new ActorInvocationFailed(options.invocationId, failure(cause, 'state-encoding'));
    }
  }
  if (!handler)
    throw new ActorInvocationFailed(
      options.invocationId,
      failure(new Error(`Unknown message ${options.messageType}`), 'message-decoding'),
    );
  if (handler.message.result.name !== options.resultType)
    throw new ActorInvocationFailed(
      options.invocationId,
      failure(
        new Error('Stored result type differs from registered result type'),
        'result-contract',
      ),
    );
  let payload: unknown;
  try {
    payload = handler.message.payload.decode(options.payload);
  } catch (cause) {
    throw new ActorInvocationFailed(options.invocationId, failure(cause, 'message-decoding'));
  }
  let sealed = false;
  let changed = false;
  const sends: { options: Send<unknown, unknown>; invocationId: string }[] = [];
  const reminders = new Map<string, { options: Reminder<unknown>; generation: string } | null>();
  let ordinal = 0;
  const open = () => {
    if (sealed) throw new BrandoError('The handler turn is sealed');
    signal.throwIfAborted();
  };
  const scope: HandlerScope<unknown, unknown> = {
    id,
    self: actor.type.ref(id),
    invocationId: options.invocationId,
    signal,
    get state() {
      return state;
    },
    update(transform) {
      open();
      state = transform(state);
      changed = true;
      return state;
    },
    idempotencyKey(purpose) {
      return idempotencyKey({
        application: options.application,
        invocationId: options.invocationId,
        purpose,
      });
    },
    send(send) {
      open();
      const invocationId = `brando:send:${options.incarnation}:${sends.length}`;
      sends.push({ options: send, invocationId });
      return invocationId;
    },
    remind(reminder) {
      open();
      durableName(reminder.name);
      reminders.set(reminder.name, {
        options: reminder,
        generation: `brando:reminder:${options.incarnation}:${ordinal++}`,
      });
    },
    cancelReminder(name) {
      open();
      durableName(name);
      reminders.set(name, null);
    },
  };
  let result: unknown;
  try {
    result = await handler.run(scope, payload);
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    throw new ActorInvocationFailed(options.invocationId, failure(cause));
  } finally {
    sealed = true;
  }
  signal.throwIfAborted();
  let encodedResult: Json;
  let encodedState: Json;
  try {
    encodedResult = handler.message.result.encode(result);
  } catch (cause) {
    throw new ActorInvocationFailed(options.invocationId, failure(cause, 'result-encoding'));
  }
  try {
    encodedState = changed ? actor.state.preserve(baseline, actor.state.encode(state)) : baseline;
  } catch (cause) {
    throw new ActorInvocationFailed(options.invocationId, failure(cause, 'state-encoding'));
  }
  const plannedSends: PlannedSend[] = [];
  const plannedReminders: PlannedReminder[] = [];
  try {
    for (const send of sends) {
      if (send.options.message.result !== unit)
        throw new BrandoError('Sends require a unit result');
      plannedSends.push({
        ...envelope({ registrations: options.contracts ?? options.registrations, ...send.options }),
        invocationId: send.invocationId,
      });
    }
  } catch (cause) {
    throw new ActorInvocationFailed(options.invocationId, failure(cause, 'send-contract'));
  }
  try {
    for (const [name, reminder] of reminders) {
      if (reminder === null) {
        plannedReminders.push({ name, cancel: true });
        continue;
      }
      const { options: intent, generation } = reminder;
      if (intent.message.result !== unit) throw new BrandoError('Reminders require a unit result');
      const encoded = envelope({
        registrations: options.registrations,
        target: scope.self,
        message: intent.message,
        payload: intent.payload,
      });
      const at = intent.at?.toISOString() ?? null;
      const afterMs = intent.afterMs === undefined ? null : Math.max(0, intent.afterMs);
      if (
        (at === null) === (afterMs === null) ||
        (afterMs !== null && (!Number.isFinite(afterMs) || afterMs > 250_000_000_000_000)) ||
        (at !== null && (at < '0001' || at > '9999'))
      )
        throw new BrandoError('Reminder needs a finite afterMs or a valid at date');
      plannedReminders.push({
        name,
        cancel: false,
        generation,
        at,
        afterMs,
        messageType: encoded.messageType,
        payload: encoded.payload,
      });
    }
  } catch (cause) {
    throw new ActorInvocationFailed(options.invocationId, failure(cause, 'reminder-contract'));
  }
  return {
    state: encodedState,
    result: encodedResult,
    sends: plannedSends,
    reminders: plannedReminders,
  };
}
