import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import {
  AmbiguousSubmission,
  BrandoError,
  DatabaseError,
  InvocationIdConflict,
  LeaseLost,
  RegistrationError,
  canonical,
  unit,
} from './model.js';
import type { Failure, Json } from './model.js';
import type { Envelope, TurnPlan } from './kernel.js';

export interface ActorRow extends QueryResultRow {
  application: string;
  actor_type: string;
  actor_key: string;
  actor_id: Json;
  id_type: string;
  state_type: string;
  state: Json | null;
  revision: string;
  next_sequence: string;
  lease_owner: string | null;
  lease_until: Date | null;
  fence: string;
  created_at: Date;
  updated_at: Date;
}
export interface MessageRow extends QueryResultRow {
  application: string;
  invocation_id: string;
  incarnation: string;
  actor_type: string;
  actor_key: string;
  sequence: string;
  message_type: string;
  result_type: string;
  payload: Json;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  result: Json | null;
  failure: Failure | null;
  attempt_count: number;
  accepted_at: Date;
  completed_at: Date | null;
  age_ms: number;
}
export interface ReminderRow extends QueryResultRow {
  actor_type: string;
  actor_key: string;
  name: string;
  generation: string;
  message_type: string;
  payload: Json;
  due_at: Date;
}
export const actorKey = (id: Json) => createHash('sha256').update(canonical(id)).digest('hex');
export class Store {
  constructor(
    readonly pool: Pool,
    readonly schema: string,
    readonly application: string,
  ) {}
  async tx<T>(operation: (client: PoolClient) => Promise<T>, submissionId?: string): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (cause) {
      throw new DatabaseError(cause);
    }
    let committing = false;
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      committing = true;
      await client.query('COMMIT');
      return value;
    } catch (cause) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* A lost connection is destroyed on release below. */
      }
      if (cause instanceof BrandoError) throw cause;
      const code = (cause as { code?: string })?.code;
      if (
        committing &&
        submissionId &&
        (!code || !/^[0-9A-Z]{5}$/.test(code) || code.startsWith('08') || code.startsWith('57'))
      )
        throw new AmbiguousSubmission(submissionId, cause);
      throw new DatabaseError(cause);
    } finally {
      client.release();
    }
  }
  async lockActor(client: PoolClient, e: Envelope): Promise<ActorRow> {
    const key = actorKey(e.actorId);
    await client.query(
      `INSERT INTO ${this.schema}.actors(application,actor_type,actor_key,actor_id,id_type,state_type) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT DO NOTHING`,
      [this.application, e.actorType, key, JSON.stringify(e.actorId), e.idType, e.stateType],
    );
    const result = await client.query<ActorRow>(
      `SELECT * FROM ${this.schema}.actors WHERE application=$1 AND actor_type=$2 AND actor_key=$3 FOR UPDATE`,
      [this.application, e.actorType, key],
    );
    const actor = result.rows[0]!;
    if (
      actor.id_type !== e.idType ||
      canonical(actor.actor_id) !== canonical(e.actorId) ||
      actor.state_type !== e.stateType
    )
      throw new RegistrationError(`Stored identity or state type differs for ${e.actorType}`);
    return actor;
  }
  async insert(client: PoolClient, e: Envelope, invocationId: string): Promise<void> {
    const key = actorKey(e.actorId);
    const seq = await client.query(
      `UPDATE ${this.schema}.actors SET next_sequence=next_sequence+1 WHERE application=$1 AND actor_type=$2 AND actor_key=$3 RETURNING next_sequence`,
      [this.application, e.actorType, key],
    );
    await client.query(
      `INSERT INTO ${this.schema}.messages(application,invocation_id,actor_type,actor_key,sequence,message_type,result_type,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        this.application,
        invocationId,
        e.actorType,
        key,
        seq.rows[0].next_sequence,
        e.messageType,
        e.resultType,
        JSON.stringify(e.payload),
      ],
    );
  }
  async submit(e: Envelope, id: string): Promise<void> {
    await this.tx(async (client) => {
      // Serialize IDs before actor locks: concurrent different-target duplicates cannot race.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
        this.application,
        id,
      ]);
      const existing = await client.query<MessageRow>(
        `SELECT * FROM ${this.schema}.messages WHERE application=$1 AND invocation_id=$2`,
        [this.application, id],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.actor_type !== e.actorType ||
          row.actor_key !== actorKey(e.actorId) ||
          row.message_type !== e.messageType ||
          row.result_type !== e.resultType ||
          canonical(row.payload) !== canonical(e.payload)
        )
          throw new InvocationIdConflict(`Invocation ${id} already has a different request`);
        return;
      }
      await this.lockActor(client, e);
      await this.insert(client, e, id);
    }, id);
  }
  async find(id: string): Promise<MessageRow | null> {
    try {
      return (
        (
          await this.pool.query<MessageRow>(
            `SELECT *,extract(epoch FROM clock_timestamp()-accepted_at)*1000 AS age_ms FROM ${this.schema}.messages WHERE application=$1 AND invocation_id=$2`,
            [this.application, id],
          )
        ).rows[0] ?? null
      );
    } catch (cause) {
      throw new DatabaseError(cause);
    }
  }
  async claim({
    owner,
    duration,
    knownTypes,
    excluded,
  }: {
    owner: string;
    duration: number;
    knownTypes: string[];
    excluded: string[];
  }): Promise<ActorRow | null> {
    return this.tx(async (client) => {
      const candidate = await client.query<ActorRow>(
        `SELECT a.* FROM ${this.schema}.actors a
        WHERE application=$1 AND actor_type=ANY($2::text[]) AND NOT ((actor_type||':'||actor_key)=ANY($3::text[]))
        AND (lease_owner IS NULL OR lease_until<=clock_timestamp())
        AND EXISTS(SELECT 1 FROM ${this.schema}.messages m WHERE m.application=a.application AND m.actor_type=a.actor_type AND m.actor_key=a.actor_key AND status IN ('PENDING','RUNNING'))
        ORDER BY available_at,actor_type,actor_key LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
        [this.application, knownTypes, excluded],
      );
      const actor = candidate.rows[0];
      if (!actor) return null;
      const updated = await client.query<ActorRow>(
        `UPDATE ${this.schema}.actors SET lease_owner=$4,lease_until=clock_timestamp()+$5*interval '1 millisecond',fence=fence+1 WHERE application=$1 AND actor_type=$2 AND actor_key=$3 RETURNING *`,
        [this.application, actor.actor_type, actor.actor_key, owner, duration],
      );
      return updated.rows[0]!;
    });
  }
  async renew({
    actor,
    owner,
    duration,
  }: {
    actor: ActorRow;
    owner: string;
    duration: number;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.schema}.actors SET lease_until=clock_timestamp()+$6*interval '1 millisecond' WHERE application=$1 AND actor_type=$2 AND actor_key=$3 AND lease_owner=$4 AND fence=$5 AND lease_until>clock_timestamp()`,
      [this.application, actor.actor_type, actor.actor_key, owner, actor.fence, duration],
    );
    return result.rowCount === 1;
  }
  async release(actor: ActorRow, owner: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.actors SET lease_owner=NULL,lease_until=NULL,available_at=clock_timestamp() WHERE application=$1 AND actor_type=$2 AND actor_key=$3 AND lease_owner=$4 AND fence=$5`,
      [this.application, actor.actor_type, actor.actor_key, owner, actor.fence],
    );
  }
  async head(actor: ActorRow): Promise<MessageRow | null> {
    return (
      (
        await this.pool.query<MessageRow>(
          `SELECT *,extract(epoch FROM clock_timestamp()-accepted_at)*1000 AS age_ms FROM ${this.schema}.messages WHERE application=$1 AND actor_type=$2 AND actor_key=$3 AND status IN ('PENDING','RUNNING') ORDER BY sequence LIMIT 1`,
          [this.application, actor.actor_type, actor.actor_key],
        )
      ).rows[0] ?? null
    );
  }
  async guard(client: PoolClient, actor: ActorRow, head: MessageRow, owner: string): Promise<void> {
    const guarded = await client.query(
      `SELECT 1 FROM ${this.schema}.actors a WHERE application=$1 AND actor_type=$2 AND actor_key=$3 AND lease_owner=$4 AND fence=$5 AND revision=$6 AND lease_until>clock_timestamp()
      AND $7=(SELECT invocation_id FROM ${this.schema}.messages m WHERE m.application=a.application AND m.actor_type=a.actor_type AND m.actor_key=a.actor_key AND status IN ('PENDING','RUNNING') ORDER BY sequence LIMIT 1)`,
      [
        this.application,
        actor.actor_type,
        actor.actor_key,
        owner,
        actor.fence,
        actor.revision,
        head.invocation_id,
      ],
    );
    if (!guarded.rowCount) throw new LeaseLost('Lease, revision, or mailbox head changed');
  }
  async markRunning(actor: ActorRow, head: MessageRow, owner: string): Promise<void> {
    await this.tx(async (client) => {
      await client.query(
        `SELECT 1 FROM ${this.schema}.actors WHERE application=$1 AND actor_type=$2 AND actor_key=$3 FOR UPDATE`,
        [this.application, actor.actor_type, actor.actor_key],
      );
      await this.guard(client, actor, head, owner);
      await client.query(
        `UPDATE ${this.schema}.messages SET status='RUNNING',attempt_owner=$3,attempt_fence=$4,attempt_count=attempt_count+1,started_at=clock_timestamp() WHERE application=$1 AND invocation_id=$2`,
        [this.application, head.invocation_id, owner, actor.fence],
      );
    });
  }
  async finish({
    actor,
    head,
    owner,
    plan,
    failure,
  }: {
    actor: ActorRow;
    head: MessageRow;
    owner: string;
    plan?: TurnPlan;
    failure?: Failure;
  }): Promise<void> {
    await this.tx(async (client) => {
      const source: Envelope = {
        actorType: actor.actor_type,
        actorKey: actor.actor_key,
        actorId: actor.actor_id,
        idType: actor.id_type,
        stateType: actor.state_type,
        messageType: head.message_type,
        resultType: head.result_type,
        payload: head.payload,
      };
      const identities = new Map<string, Envelope>();
      for (const e of [source, ...(plan?.sends ?? [])])
        identities.set(`${e.actorType}:${actorKey(e.actorId)}`, e);
      for (const key of [...identities.keys()].sort())
        await this.lockActor(client, identities.get(key)!);
      await this.guard(client, actor, head, owner);
      if (plan) {
        await client.query(
          `UPDATE ${this.schema}.actors SET state=$4::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE application=$1 AND actor_type=$2 AND actor_key=$3`,
          [this.application, actor.actor_type, actor.actor_key, JSON.stringify(plan.state)],
        );
        for (const send of plan.sends) await this.insert(client, send, send.invocationId);
        for (const reminder of plan.reminders) {
          const key = [this.application, actor.actor_type, actor.actor_key, reminder.name];
          if (reminder.cancel)
            await client.query(
              `DELETE FROM ${this.schema}.reminders WHERE application=$1 AND actor_type=$2 AND actor_key=$3 AND name=$4`,
              key,
            );
          else
            await client.query(
              `INSERT INTO ${this.schema}.reminders(application,actor_type,actor_key,name,generation,due_at,message_type,payload)
            VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,transaction_timestamp()+$7*interval '1 millisecond'),$8,$9::jsonb)
            ON CONFLICT(application,actor_type,actor_key,name) DO UPDATE SET generation=EXCLUDED.generation,due_at=EXCLUDED.due_at,message_type=EXCLUDED.message_type,payload=EXCLUDED.payload`,
              [
                ...key,
                reminder.generation,
                reminder.at,
                reminder.afterMs,
                reminder.messageType,
                JSON.stringify(reminder.payload),
              ],
            );
        }
      }
      await client.query(
        `UPDATE ${this.schema}.messages SET status=$3,result=$4::jsonb,failure=$5::jsonb,completed_at=clock_timestamp() WHERE application=$1 AND invocation_id=$2`,
        [
          this.application,
          head.invocation_id,
          plan ? 'COMPLETED' : 'FAILED',
          plan ? JSON.stringify(plan.result) : null,
          failure ? JSON.stringify(failure) : null,
        ],
      );
    });
    if (plan) {
      actor.state = plan.state;
      actor.revision = (BigInt(actor.revision) + 1n).toString();
    }
  }
  async materialize(knownMessages: Map<string, Set<string>>, limit = 100): Promise<number> {
    const candidates = await this.pool.query<ReminderRow>(
      `SELECT * FROM ${this.schema}.reminders WHERE application=$1 AND due_at<=clock_timestamp() AND ($3::jsonb -> actor_type) ? message_type ORDER BY due_at LIMIT $2`,
      [
        this.application,
        limit,
        JSON.stringify(
          Object.fromEntries([...knownMessages].map(([type, messages]) => [type, [...messages]])),
        ),
      ],
    );
    let count = 0;
    for (const reminder of candidates.rows) {
      if (!knownMessages.get(reminder.actor_type)?.has(reminder.message_type)) continue;
      count += await this.tx(async (client) => {
        const actors = await client.query<ActorRow>(
          `SELECT * FROM ${this.schema}.actors WHERE application=$1 AND actor_type=$2 AND actor_key=$3 FOR UPDATE SKIP LOCKED`,
          [this.application, reminder.actor_type, reminder.actor_key],
        );
        const actor = actors.rows[0];
        if (!actor) return 0;
        const exact = await client.query(
          `SELECT 1 FROM ${this.schema}.reminders WHERE application=$1 AND actor_type=$2 AND actor_key=$3 AND name=$4 AND generation=$5 AND due_at<=clock_timestamp() FOR UPDATE`,
          [
            this.application,
            reminder.actor_type,
            reminder.actor_key,
            reminder.name,
            reminder.generation,
          ],
        );
        if (!exact.rowCount) return 0;
        await this.insert(
          client,
          {
            actorType: actor.actor_type,
            actorKey: actor.actor_key,
            actorId: actor.actor_id,
            idType: actor.id_type,
            stateType: actor.state_type,
            messageType: reminder.message_type,
            resultType: unit.name,
            payload: reminder.payload,
          },
          reminder.generation,
        );
        await client.query(
          `DELETE FROM ${this.schema}.reminders WHERE application=$1 AND actor_type=$2 AND actor_key=$3 AND name=$4 AND generation=$5`,
          [
            this.application,
            reminder.actor_type,
            reminder.actor_key,
            reminder.name,
            reminder.generation,
          ],
        );
        return 1;
      });
    }
    return count;
  }
  async retain({ ageMs, limit }: { ageMs: number; limit: number }): Promise<number> {
    const result = await this.pool.query(
      `WITH expired AS (SELECT application,invocation_id FROM ${this.schema}.messages WHERE application=$1 AND status IN ('COMPLETED','FAILED') AND completed_at<clock_timestamp()-$2*interval '1 millisecond' ORDER BY completed_at LIMIT $3 FOR UPDATE SKIP LOCKED)
      DELETE FROM ${this.schema}.messages m USING expired e WHERE m.application=e.application AND m.invocation_id=e.invocation_id`,
      [this.application, ageMs, limit],
    );
    return result.rowCount ?? 0;
  }
}
