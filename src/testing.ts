import { randomUUID } from 'node:crypto';
import { contractRegistry, registry } from './model.js';
import type { ActorDefinition, AnyActor, AnyActorContract, Message } from './model.js';
import { envelope, executeTurn } from './kernel.js';

/** Executes the production turn kernel without claiming durability or scheduling. */
export async function actorTurnTest<I, S, P, R>(options: {
  actors: readonly AnyActor[];
  contracts?: readonly AnyActorContract[];
  actor: ActorDefinition<I, S>;
  id: I;
  state?: S;
  message: Message<P, R>;
  payload: P;
  application?: string;
  invocationId?: string;
  incarnation?: string;
}) {
  const registrations = registry(options.actors);
  const request = envelope({
    registrations,
    target: options.actor.type.ref(options.id),
    message: options.message,
    payload: options.payload,
  });
  const plan = await executeTurn({
    application: options.application ?? 'test',
    registrations,
    actor: options.actor.registration,
    contracts: contractRegistry({ registrations, contracts: options.contracts ?? [] }),
    ...request,
    invocationId: options.invocationId ?? `test:${randomUUID()}`,
    incarnation: options.incarnation ?? '1',
    state: options.state === undefined ? null : options.actor.state.encode(options.state),
    hasState: options.state !== undefined,
    signal: new AbortController().signal,
  });
  return {
    state: options.actor.state.decode(plan.state),
    result: options.message.result.decode(plan.result),
    sends: plan.sends,
    reminders: plan.reminders,
    stateJson: plan.state,
  };
}
