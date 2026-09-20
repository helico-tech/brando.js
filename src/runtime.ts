import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ActorInvocationFailed,
  BrandoError,
  DatabaseError,
  InvocationNotFound,
  LeaseLost,
  RegistrationError,
  ResultTypeMismatch,
  RuntimeClosed,
  StateIncompatible,
  WaitAborted,
  durableName,
  registry,
} from './model.js';
import type { ActorRef, AnyActor, Codec, Json, Message, Registration, Send } from './model.js';
import { envelope, executeTurn } from './kernel.js';
import { migrateSchema, schemaName } from './schema.js';
import type { SchemaManagement } from './schema.js';
import { Store, actorKey } from './store.js';
import type { ActorRow, MessageRow } from './store.js';

export interface BrandoConfiguration {
  schema?: string;
  schemaManagement?: SchemaManagement;
  workerCount?: number;
  leaseDurationMs?: number;
  leaseRenewalMs?: number;
  gracefulShutdownMs?: number;
  pollIntervalMs?: number;
  maxMessagesPerClaim?: number;
  maxDrainMs?: number;
  reminderIntervalMs?: number;
  terminalRetentionMs?: number;
  retentionIntervalMs?: number;
  retentionBatchSize?: number;
  unknownMessageGraceMs?: number;
}
export interface RuntimeEvent {
  kind: 'runtime-error' | 'incompatible' | 'completed' | 'failed' | 'lease-lost';
  actorType?: string;
  invocationId?: string;
  error?: unknown;
}
export interface BrandoOptions {
  name: string;
  database: string | Pool;
  actors: readonly AnyActor[];
  config?: BrandoConfiguration;
  onEvent?: (event: RuntimeEvent) => void;
}
export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface Submit<I, P, R> {
  target: ActorRef<I>;
  message: Message<P, R>;
  payload: P;
  invocationId?: string;
}
export interface Invocation<R> {
  readonly id: string;
  await(options?: WaitOptions): Promise<R>;
}
export interface PageOptions {
  limit?: number;
  offset?: number;
  actorType?: string;
  status?: string;
  search?: string;
}
const defaults = {
  schema: 'brando_js',
  schemaManagement: 'apply-rolling-safe' as SchemaManagement,
  workerCount: 4,
  leaseDurationMs: 30000,
  leaseRenewalMs: 10000,
  gracefulShutdownMs: 30000,
  pollIntervalMs: 250,
  maxMessagesPerClaim: 50,
  maxDrainMs: 5000,
  reminderIntervalMs: 250,
  terminalRetentionMs: 30 * 86400000,
  retentionIntervalMs: 3600000,
  retentionBatchSize: 1000,
  unknownMessageGraceMs: 300000,
};
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
function pagination(options: PageOptions) {
  const { limit = 50, offset = 0 } = options;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  )
    throw new BrandoError('Invalid pagination; limit 1–200, offset 0–1000000');
  return { limit, offset };
}
export class Brando {
  readonly name: string;
  readonly owner = randomUUID();
  readonly config: Required<BrandoConfiguration>;
  private readonly registrations: Map<string, Registration>;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly store: Store;
  private readonly stopping = new AbortController();
  private readonly active = new Set<AbortController>();
  private readonly excluded = new Map<string, number>();
  private readonly tasks: Promise<void>[] = [];
  private closed = false;
  private closeTask?: Promise<void>;
  private lastError: string | null = null;
  private readonly startedAt = Date.now();
  private metrics = {
    completed: 0,
    failed: 0,
    attempts: 0,
    leaseLost: 0,
    runtimeErrors: 0,
    reminders: 0,
    purged: 0,
  };
  private readonly poolError = (error: Error) => this.emit({ kind: 'runtime-error', error });
  private constructor(private readonly options: BrandoOptions) {
    durableName(options.name);
    this.name = options.name;
    this.config = { ...defaults, ...options.config };
    schemaName(this.config.schema);
    if (
      !['apply-rolling-safe', 'apply-all', 'validate-only'].includes(this.config.schemaManagement)
    )
      throw new RegistrationError('Unknown schema management mode');
    for (const [key, value] of Object.entries(this.config))
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
        throw new RegistrationError(`${key} must be a positive safe integer`);
    if (this.config.leaseRenewalMs >= this.config.leaseDurationMs / 2)
      throw new RegistrationError('Lease renewal must be less than half the lease duration');
    if (this.config.workerCount > 256)
      throw new RegistrationError('workerCount must be at most 256');
    this.registrations = registry(options.actors);
    this.ownsPool = typeof options.database === 'string';
    this.pool =
      typeof options.database === 'string'
        ? new Pool({
            connectionString: options.database,
            max: this.config.workerCount + 4,
            connectionTimeoutMillis: 5000,
            statement_timeout: 10000,
            idle_in_transaction_session_timeout: 15000,
          })
        : options.database;
    this.store = new Store(this.pool, this.config.schema, this.name);
  }
  static async start(options: BrandoOptions): Promise<Brando> {
    const runtime = new Brando(options);
    runtime.pool.on('error', runtime.poolError);
    try {
      await migrateSchema({
        database: runtime.pool,
        schema: runtime.config.schema,
        mode: runtime.config.schemaManagement,
      });
    } catch (cause) {
      runtime.pool.off('error', runtime.poolError);
      if (runtime.ownsPool) await runtime.pool.end();
      if (cause instanceof BrandoError) throw cause;
      throw new DatabaseError(cause);
    }
    for (let i = 0; i < runtime.config.workerCount; i++) runtime.tasks.push(runtime.worker());
    runtime.tasks.push(runtime.maintenance());
    return runtime;
  }
  private emit(event: RuntimeEvent) {
    if (event.kind === 'runtime-error') {
      this.metrics.runtimeErrors++;
      this.lastError = event.error instanceof Error ? event.error.message : String(event.error);
    }
    try {
      this.options.onEvent?.(event);
    } catch {
      /* Observer failures must not change actor outcomes. */
    }
  }
  async submit<I, P, R>(options: Submit<I, P, R>): Promise<Invocation<R>> {
    if (this.closed) throw new RuntimeClosed('Runtime is closed');
    const id = options.invocationId ?? randomUUID();
    if (
      !id ||
      Buffer.byteLength(id) > 1000 ||
      id.includes('\0') ||
      !id.isWellFormed() ||
      id.startsWith('brando:')
    )
      throw new RegistrationError(
        'Invocation ID must be 1–1000 UTF-8 bytes and cannot use the brando: namespace',
      );
    let request;
    try {
      request = envelope({ registrations: this.registrations, ...options });
    } catch (cause) {
      if (cause instanceof BrandoError) throw cause;
      throw new RegistrationError('Message or actor ID validation failed', { cause });
    }
    await this.store.submit(request, id);
    return this.handle(id, options.message.result);
  }
  async call<I, P, R>(options: Submit<I, P, R> & WaitOptions): Promise<R> {
    return (await this.submit(options)).await(options);
  }
  async send<I, P>(options: Send<I, P> & { invocationId?: string }): Promise<string> {
    return (await this.submit(options)).id;
  }
  async invocation<R>({
    id,
    result,
  }: {
    id: string;
    result: Codec<R>;
  }): Promise<Invocation<R> | null> {
    const row = await this.store.find(id);
    if (!row) return null;
    if (row.result_type !== result.name)
      throw new ResultTypeMismatch(`Expected ${result.name}; stored ${row.result_type}`);
    return this.handle(id, result);
  }
  private handle<R>(id: string, codec: Codec<R>): Invocation<R> {
    return {
      id,
      await: async ({ signal, timeoutMs }: WaitOptions = {}) => {
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
          throw new BrandoError('timeoutMs must be positive');
        const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
        while (true) {
          if (signal?.aborted || Date.now() >= deadline)
            throw new WaitAborted(`Local wait stopped; invocation ${id} remains accepted`, {
              cause: signal?.reason,
            });
          if (this.closed)
            throw new RuntimeClosed(`Runtime closed; resume invocation ${id} on another runtime`);
          const row = await this.store.find(id);
          if (!row)
            throw new InvocationNotFound(`Invocation ${id} is absent or its retention expired`);
          if (row.result_type !== codec.name)
            throw new ResultTypeMismatch(`Expected ${codec.name}; stored ${row.result_type}`);
          if (row.status === 'FAILED') throw new ActorInvocationFailed(id, row.failure!);
          if (row.status === 'COMPLETED') {
            try {
              return codec.decode(row.result);
            } catch (cause) {
              throw new BrandoError(`Cannot decode result of ${id}`, { cause });
            }
          }
          await delay(
            Math.min(this.config.pollIntervalMs, Math.max(1, deadline - Date.now())),
            signal,
          );
        }
      },
    };
  }
  private async worker(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      let claim: ActorRow | null = null;
      try {
        for (const [key, until] of this.excluded)
          if (until <= Date.now()) this.excluded.delete(key);
        claim = await this.store.claim({
          owner: this.owner,
          duration: this.config.leaseDurationMs,
          knownTypes: [...this.registrations.keys()],
          excluded: [...this.excluded.keys()],
        });
        if (claim) await this.drain(claim);
      } catch (error) {
        if (error instanceof LeaseLost) {
          this.metrics.leaseLost++;
          this.emit({ kind: 'lease-lost', error });
        } else if (error instanceof StateIncompatible && claim) {
          this.excluded.set(
            `${claim.actor_type}:${claim.actor_key}`,
            Date.now() + Math.max(1000, this.config.pollIntervalMs),
          );
          this.emit({ kind: 'incompatible', actorType: claim.actor_type, error });
        } else this.emit({ kind: 'runtime-error', error });
        await delay(this.config.pollIntervalMs, this.stopping.signal);
      } finally {
        if (claim)
          try {
            await this.store.release(claim, this.owner);
          } catch (error) {
            this.emit({ kind: 'runtime-error', error });
          }
      }
      if (!claim) await delay(this.config.pollIntervalMs, this.stopping.signal);
    }
  }
  private async drain(claim: ActorRow): Promise<void> {
    const controller = new AbortController();
    this.active.add(controller);
    const renewalStop = new AbortController();
    const renewal = (async () => {
      while (!renewalStop.signal.aborted) {
        await delay(this.config.leaseRenewalMs, renewalStop.signal);
        if (renewalStop.signal.aborted) break;
        try {
          if (
            !(await this.store.renew({
              actor: claim,
              owner: this.owner,
              duration: this.config.leaseDurationMs,
            }))
          ) {
            controller.abort(new LeaseLost('Lease renewal rejected'));
            break;
          }
        } catch (cause) {
          controller.abort(new LeaseLost('Lease renewal failed', { cause }));
          break;
        }
      }
    })();
    const deadline = Date.now() + this.config.maxDrainMs;
    try {
      for (
        let i = 0;
        i < this.config.maxMessagesPerClaim &&
        Date.now() < deadline &&
        !this.stopping.signal.aborted;
        i++
      ) {
        controller.signal.throwIfAborted();
        const head = await this.store.head(claim);
        if (!head) break;
        const registration = this.registrations.get(claim.actor_type)!;
        if (
          claim.state_type !== registration.state.name ||
          claim.id_type !== registration.type.id.name
        )
          throw new StateIncompatible('Stored actor identity differs from this registration');
        if (
          !registration.handlers.has(head.message_type) &&
          Number(head.age_ms) < this.config.unknownMessageGraceMs
        )
          throw new StateIncompatible(
            `Unknown message ${head.message_type}; deferring during deployment grace`,
          );
        await this.store.markRunning(claim, head, this.owner);
        this.metrics.attempts++;
        // Race the attempt with cancellation so a non-cooperative handler cannot pin a worker.
        let abort: (() => void) | undefined;
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
        try {
          const plan = await Promise.race([
            executeTurn({
              application: this.name,
              registrations: this.registrations,
              actor: registration,
              actorId: claim.actor_id,
              invocationId: head.invocation_id,
              incarnation: head.incarnation,
              state: claim.state,
              hasState: BigInt(claim.revision) > 0n,
              messageType: head.message_type,
              resultType: head.result_type,
              payload: head.payload,
              signal: controller.signal,
            }),
            interrupted,
          ]);
          controller.signal.throwIfAborted();
          await this.store.finish({ actor: claim, head, owner: this.owner, plan });
          this.metrics.completed++;
          this.emit({
            kind: 'completed',
            actorType: claim.actor_type,
            invocationId: head.invocation_id,
          });
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!(error instanceof ActorInvocationFailed)) throw error;
          await this.store.finish({
            actor: claim,
            head,
            owner: this.owner,
            failure: error.failure,
          });
          this.metrics.failed++;
          this.emit({
            kind: 'failed',
            actorType: claim.actor_type,
            invocationId: head.invocation_id,
          });
        } finally {
          if (abort) controller.signal.removeEventListener('abort', abort);
        }
      }
    } finally {
      renewalStop.abort();
      await renewal;
      this.active.delete(controller);
    }
  }
  private async maintenance(): Promise<void> {
    let retentionAt = 0;
    const known = new Map(
      [...this.registrations].map(([name, actor]) => [name, new Set([...actor.handlers.keys()])]),
    );
    while (!this.stopping.signal.aborted) {
      try {
        this.metrics.reminders += await this.store.materialize(known);
        if (Date.now() >= retentionAt) {
          const until = Date.now() + Math.max(1, this.config.retentionIntervalMs / 4);
          let count: number;
          do {
            count = await this.store.retain({
              ageMs: this.config.terminalRetentionMs,
              limit: this.config.retentionBatchSize,
            });
            this.metrics.purged += count;
          } while (
            count === this.config.retentionBatchSize &&
            Date.now() < until &&
            !this.stopping.signal.aborted
          );
          retentionAt = Date.now() + this.config.retentionIntervalMs;
        }
      } catch (error) {
        this.emit({ kind: 'runtime-error', error });
      }
      await delay(this.config.reminderIntervalMs, this.stopping.signal);
    }
  }
  async health() {
    let database: boolean;
    try {
      const result = await this.pool.query(
        `SELECT version FROM ${this.config.schema}.schema_version`,
      );
      database = result.rows.length === 1 && result.rows[0].version === 1;
    } catch {
      database = false;
    }
    return {
      live: !this.closed,
      ready: !this.closed && database,
      database,
      name: this.name,
      owner: this.owner,
      uptimeMs: Date.now() - this.startedAt,
      lastError: this.lastError,
      metrics: { ...this.metrics },
      incompatibleActors: this.excluded.size,
    };
  }
  catalogue() {
    return [...this.registrations.values()].map((actor) => ({
      name: actor.type.name,
      idType: actor.type.id.name,
      idSchema: actor.type.id.schema,
      stateType: actor.state.name,
      stateSchema: actor.state.schema,
      messages: [...actor.handlers.values()].map(({ message }) => ({
        name: message.name,
        payloadSchema: message.payload.schema,
        resultType: message.result.name,
        resultSchema: message.result.schema,
      })),
    }));
  }
  private async query<T extends Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    try {
      return (await this.pool.query<T>(sql, [this.name, ...values])).rows;
    } catch (cause) {
      throw new DatabaseError(cause);
    }
  }
  async overview() {
    const s = this.config.schema;
    const [counts, actors, reminders, activity] = await Promise.all([
      this.query(
        `SELECT status,count(*)::int AS count FROM ${s}.messages WHERE application=$1 GROUP BY status`,
      ),
      this.query(
        `SELECT count(*)::int AS total,count(*) FILTER (WHERE lease_owner IS NOT NULL AND lease_until>clock_timestamp())::int AS leased FROM ${s}.actors WHERE application=$1`,
      ),
      this.query(
        `SELECT count(*)::int AS total,count(*) FILTER (WHERE due_at<=clock_timestamp())::int AS due FROM ${s}.reminders WHERE application=$1`,
      ),
      this.query(
        `SELECT date_trunc('minute',completed_at) AS time,count(*) FILTER(WHERE status='COMPLETED')::int AS completed,count(*) FILTER(WHERE status='FAILED')::int AS failed FROM ${s}.messages WHERE application=$1 AND completed_at>clock_timestamp()-interval '1 hour' GROUP BY 1 ORDER BY 1`,
      ),
    ]);
    return {
      health: await this.health(),
      counts,
      actors: actors[0],
      reminders: reminders[0],
      activity,
      catalogue: this.catalogue(),
    };
  }
  async actors(options: PageOptions = {}) {
    const { limit, offset } = pagination(options);
    return this.query(
      `SELECT a.*, (SELECT count(*)::int FROM ${this.config.schema}.messages m WHERE m.application=a.application AND m.actor_type=a.actor_type AND m.actor_key=a.actor_key AND m.status IN ('PENDING','RUNNING')) AS pending FROM ${this.config.schema}.actors a WHERE application=$1 AND ($2::text IS NULL OR actor_type=$2) AND ($3::text IS NULL OR position(lower($3) in lower(actor_id::text))>0) ORDER BY actor_type,actor_key LIMIT $4 OFFSET $5`,
      [options.actorType ?? null, options.search ?? null, limit, offset],
    );
  }
  async invocations(options: PageOptions = {}) {
    const { limit, offset } = pagination(options);
    if (options.status && !['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'].includes(options.status))
      throw new BrandoError('Invalid invocation status');
    return this.query(
      `SELECT m.*,a.actor_id FROM ${this.config.schema}.messages m JOIN ${this.config.schema}.actors a USING(application,actor_type,actor_key) WHERE application=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR actor_type=$3) AND ($4::text IS NULL OR position(lower($4) in lower(invocation_id))>0) ORDER BY accepted_at DESC,invocation_id LIMIT $5 OFFSET $6`,
      [options.status ?? null, options.actorType ?? null, options.search ?? null, limit, offset],
    );
  }
  async reminders(options: PageOptions = {}) {
    const { limit, offset } = pagination(options);
    return this.query(
      `SELECT r.*,a.actor_id FROM ${this.config.schema}.reminders r JOIN ${this.config.schema}.actors a USING(application,actor_type,actor_key) WHERE application=$1 AND ($2::text IS NULL OR actor_type=$2) ORDER BY due_at,name LIMIT $3 OFFSET $4`,
      [options.actorType ?? null, limit, offset],
    );
  }
  async inspectActor({ actorType, id }: { actorType: string; id: Json }) {
    const key = actorKey(id);
    const [actors, messages, reminders] = await Promise.all([
      this.query(
        `SELECT * FROM ${this.config.schema}.actors WHERE application=$1 AND actor_type=$2 AND actor_key=$3`,
        [actorType, key],
      ),
      this.query(
        `SELECT * FROM ${this.config.schema}.messages WHERE application=$1 AND actor_type=$2 AND actor_key=$3 ORDER BY sequence DESC LIMIT 100`,
        [actorType, key],
      ),
      this.query(
        `SELECT * FROM ${this.config.schema}.reminders WHERE application=$1 AND actor_type=$2 AND actor_key=$3 ORDER BY due_at LIMIT 100`,
        [actorType, key],
      ),
    ]);
    return actors[0] ? { actor: actors[0], messages, reminders } : null;
  }
  async inspectInvocation(id: string): Promise<MessageRow | null> {
    return this.store.find(id);
  }
  async submitJson({
    actorType,
    id,
    messageType,
    payload,
    invocationId,
  }: {
    actorType: string;
    id: Json;
    messageType: string;
    payload: Json;
    invocationId?: string;
  }): Promise<string> {
    const actor = this.registrations.get(actorType);
    const handler = actor?.handlers.get(messageType);
    if (!actor || !handler) throw new RegistrationError('Unknown actor or message type');
    return (
      await this.submit({
        target: actor.type.ref(actor.type.id.decode(id)),
        message: handler.message,
        payload: handler.message.payload.decode(payload),
        invocationId,
      })
    ).id;
  }
  async resubmit({ id, invocationId }: { id: string; invocationId?: string }): Promise<string> {
    const source = await this.store.find(id);
    if (!source) throw new InvocationNotFound(`Invocation ${id} not found`);
    if (!['COMPLETED', 'FAILED'].includes(source.status))
      throw new BrandoError('Only terminal invocations may be resubmitted');
    const actors = await this.query(
      `SELECT actor_id FROM ${this.config.schema}.actors WHERE application=$1 AND actor_type=$2 AND actor_key=$3`,
      [source.actor_type, source.actor_key],
    );
    return this.submitJson({
      actorType: source.actor_type,
      id: actors[0]!.actor_id as Json,
      messageType: source.message_type,
      payload: source.payload,
      invocationId,
    });
  }
  close(): Promise<void> {
    this.closeTask ??= (async () => {
      this.closed = true;
      this.stopping.abort();
      const graceful = new AbortController();
      await Promise.race([
        Promise.all(this.tasks),
        delay(this.config.gracefulShutdownMs, graceful.signal),
      ]);
      graceful.abort();
      for (const active of this.active) active.abort(new LeaseLost('Runtime shutdown'));
      await Promise.all(this.tasks);
      this.pool.off('error', this.poolError);
      if (this.ownsPool) await this.pool.end();
    })();
    return this.closeTask;
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}
