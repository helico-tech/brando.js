import { createHash } from 'node:crypto';
import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export class BrandoError extends Error {
  override name = 'BrandoError';
}
export class RegistrationError extends BrandoError {
  override name = 'RegistrationError';
}
export class InvocationIdConflict extends BrandoError {
  override name = 'InvocationIdConflict';
}
export class ResultTypeMismatch extends BrandoError {
  override name = 'ResultTypeMismatch';
}
export class InvocationNotFound extends BrandoError {
  override name = 'InvocationNotFound';
}
export class RuntimeClosed extends BrandoError {
  override name = 'RuntimeClosed';
}
export class WaitAborted extends BrandoError {
  override name = 'WaitAborted';
}
export class UnsupportedSchema extends BrandoError {
  override name = 'UnsupportedSchema';
}
export class DatabaseError extends BrandoError {
  override name = 'DatabaseError';
  readonly retryable: boolean;
  constructor(cause: unknown) {
    super('PostgreSQL operation failed', { cause });
    const code = (cause as { code?: string })?.code ?? '';
    this.retryable = !/^(22|23|28|42)/.test(code);
  }
}
export class AmbiguousSubmission extends DatabaseError {
  override name = 'AmbiguousSubmission';
  constructor(
    readonly invocationId: string,
    cause: unknown,
  ) {
    super(cause);
  }
}
export interface Failure {
  category: string;
  name: string;
  message: string;
}
export class ActorInvocationFailed extends BrandoError {
  override name = 'ActorInvocationFailed';
  constructor(
    readonly invocationId: string,
    readonly failure: Failure,
  ) {
    super(`${failure.category}: ${failure.message}`);
  }
}
export class LeaseLost extends BrandoError {
  override name = 'LeaseLost';
}
export class StateIncompatible extends BrandoError {
  override name = 'StateIncompatible';
}

export function json(value: unknown): Json {
  const seen = new Set<object>();
  const visit = (v: unknown): Json => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string' && !v.includes('\0') && v.isWellFormed()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return Object.is(v, -0) ? 0 : v;
    if (typeof v !== 'object' || v === null || seen.has(v))
      throw new BrandoError('Value is not losslessly representable as JSON');
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new BrandoError('JSON values must use plain objects');
    seen.add(v);
    const out: Json = Array.isArray(v)
      ? Array.from(v, visit)
      : Object.fromEntries(
          Object.entries(v).map(([key, val]) => {
            if (key.includes('\0') || !key.isWellFormed())
              throw new BrandoError('Invalid JSON key');
            return [key, visit(val)];
          }),
        );
    seen.delete(v);
    return out;
  };
  return visit(value);
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function preserve(base: Json, next: Json, shape: Record<string, unknown>): Json {
  if (
    base === null ||
    next === null ||
    Array.isArray(base) ||
    Array.isArray(next) ||
    typeof base !== 'object' ||
    typeof next !== 'object'
  )
    return next;
  const properties = shape.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return next;
  const out = { ...next };
  for (const [key, value] of Object.entries(base)) {
    if (!Object.hasOwn(properties, key) && !Object.hasOwn(out, key))
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else if (Object.hasOwn(next, key)) out[key] = preserve(value, next[key]!, properties[key]!);
  }
  return out;
}
export interface Codec<T> {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  encode(value: T): Json;
  decode(value: Json): T;
  preserve(base: Json, next: Json): Json;
}
export function codec<T>(name: string, schema: z.ZodType<T>): Codec<T> {
  durableName(name);
  const shape = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  return {
    name,
    schema: shape,
    encode: (value) => json(schema.parse(value)),
    decode: (value) => schema.parse(structuredClone(value)),
    preserve: (base, next) => preserve(base, next, shape),
  };
}
export const unit: Codec<void> = {
  name: 'brando.unit.v1',
  schema: { type: 'null' },
  encode(value) {
    if (value !== undefined) throw new BrandoError('Unit handlers must not return a value');
    return null;
  },
  decode(value) {
    if (value !== null) throw new BrandoError('Invalid unit result');
  },
  preserve: (_base, next) => next,
};
export function durableName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.length < 1 ||
    name.length > 200 ||
    name.includes('\0') ||
    !name.isWellFormed()
  )
    throw new RegistrationError('Durable names must be 1–200 valid characters');
}
export interface ActorType<I> {
  readonly name: string;
  readonly id: Codec<I>;
  ref(id: I): ActorRef<I>;
}
export interface ActorRef<I> {
  readonly type: ActorType<I>;
  readonly id: I;
}
export function actorType<I>({ name, id }: { name: string; id: Codec<I> }): ActorType<I> {
  durableName(name);
  return Object.freeze({
    name,
    id,
    ref(value: I) {
      return { type: this, id: value };
    },
  });
}
export interface Message<P, R> {
  readonly name: string;
  readonly payload: Codec<P>;
  readonly result: Codec<R>;
}
export function message<P, R>({
  name,
  payload,
  result,
}: {
  name: string;
  payload: z.ZodType<P>;
  result: Codec<R>;
}): Message<P, R> {
  durableName(name);
  return Object.freeze({ name, payload: codec(name, payload), result });
}
export interface Send<I, P> {
  target: ActorRef<I>;
  message: Message<P, void>;
  payload: P;
}
export type Reminder<P> = { name: string; message: Message<P, void>; payload: P } & (
  { at: Date; afterMs?: never } | { afterMs: number; at?: never }
);
export interface HandlerScope<I, S> {
  readonly id: I;
  readonly self: ActorRef<I>;
  readonly state: S;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  update(transform: (state: S) => S): S;
  idempotencyKey(purpose?: string): string;
  send<T, P>(options: Send<T, P>): string;
  remind<P>(options: Reminder<P>): void;
  cancelReminder(name: string): void;
}
export interface HandlerRegistration {
  message: Message<unknown, unknown>;
  run(scope: HandlerScope<unknown, unknown>, payload: unknown): Promise<unknown>;
}
export type On<I, S> = <P, R>(
  message: Message<P, R>,
  handle: (scope: HandlerScope<I, S>, payload: P) => R | Promise<R>,
) => HandlerRegistration;
export interface Registration {
  type: ActorType<unknown>;
  state: Codec<unknown>;
  initial(id: unknown): unknown;
  handlers: Map<string, HandlerRegistration>;
}
export interface AnyActor {
  readonly registration: Registration;
}
export interface ActorDefinition<I, S> extends AnyActor {
  readonly type: ActorType<I>;
  readonly state: Codec<S>;
}
export function defineActor<I, S>(options: {
  type: ActorType<I>;
  state: Codec<S>;
  initial: (id: I) => S;
  handlers: (on: On<I, S>) => HandlerRegistration[];
}): ActorDefinition<I, S> {
  const on: On<I, S> = (msg, handle) => ({
    message: msg,
    run: async (scope, payload) => handle(scope as HandlerScope<I, S>, payload as never),
  });
  const handlers = new Map<string, HandlerRegistration>();
  for (const handler of options.handlers(on)) {
    if (handlers.has(handler.message.name))
      throw new RegistrationError(`Duplicate message ${handler.message.name}`);
    handlers.set(handler.message.name, handler);
  }
  if (!handlers.size) throw new RegistrationError('An actor needs at least one handler');
  return {
    type: options.type,
    state: options.state,
    registration: {
      type: options.type,
      state: options.state,
      initial: (id) => options.initial(id as I),
      handlers,
    },
  };
}
export function registry(actors: readonly AnyActor[]): Map<string, Registration> {
  const registrations = new Map<string, Registration>();
  for (const actor of actors) {
    const registration = actor.registration;
    if (registrations.has(registration.type.name))
      throw new RegistrationError(`Duplicate actor ${registration.type.name}`);
    registrations.set(registration.type.name, registration);
  }
  if (!registrations.size) throw new RegistrationError('Register at least one actor');
  return registrations;
}
export function idempotencyKey({
  application,
  invocationId,
  purpose = 'default',
}: {
  application: string;
  invocationId: string;
  purpose?: string;
}): string {
  return createHash('sha256')
    .update(
      'brando:idk:v2' +
        [application, invocationId, purpose].map((part) => `:${part.length}:${part}`).join(''),
    )
    .digest('hex');
}
