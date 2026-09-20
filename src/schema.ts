import type { Pool } from 'pg';
import { RegistrationError, UnsupportedSchema } from './model.js';
export type SchemaManagement = 'apply-rolling-safe' | 'apply-all' | 'validate-only';
export function schemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
    throw new RegistrationError('Schema must match [a-z_][a-z0-9_]* and fit 63 characters');
  return schema;
}
export function schemaMigrations({ schema = 'brando_js' }: { schema?: string } = {}) {
  const s = schemaName(schema);
  return [
    {
      version: 1,
      rollingSafe: true,
      sql: `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE ${s}.schema_version (version integer PRIMARY KEY);
CREATE SEQUENCE ${s}.incarnations AS bigint NO CYCLE;
CREATE TABLE ${s}.actors (
  application text NOT NULL, actor_type text NOT NULL, actor_key text NOT NULL,
  actor_id jsonb NOT NULL, id_type text NOT NULL, state_type text NOT NULL,
  state jsonb, revision bigint NOT NULL DEFAULT 0, next_sequence bigint NOT NULL DEFAULT 0,
  lease_owner uuid, lease_until timestamptz, fence bigint NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (application, actor_type, actor_key)
);
CREATE TABLE ${s}.messages (
  application text NOT NULL, invocation_id text NOT NULL, incarnation bigint NOT NULL DEFAULT nextval('${s}.incarnations'),
  actor_type text NOT NULL, actor_key text NOT NULL, sequence bigint NOT NULL,
  message_type text NOT NULL, result_type text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  result jsonb, failure jsonb, attempt_count integer NOT NULL DEFAULT 0,
  attempt_owner uuid, attempt_fence bigint,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz, completed_at timestamptz,
  PRIMARY KEY (application, invocation_id), UNIQUE (application, actor_type, actor_key, sequence),
  FOREIGN KEY (application, actor_type, actor_key) REFERENCES ${s}.actors(application, actor_type, actor_key)
);
CREATE TABLE ${s}.reminders (
  application text NOT NULL, actor_type text NOT NULL, actor_key text NOT NULL, name text NOT NULL,
  generation text NOT NULL, due_at timestamptz NOT NULL, message_type text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (application, actor_type, actor_key, name),
  FOREIGN KEY (application, actor_type, actor_key) REFERENCES ${s}.actors(application, actor_type, actor_key)
);
CREATE INDEX messages_dispatch ON ${s}.messages(application, actor_type, actor_key, sequence) WHERE status IN ('PENDING','RUNNING');
CREATE INDEX actors_claim ON ${s}.actors(application, available_at, lease_until);
CREATE INDEX messages_terminal ON ${s}.messages(application, completed_at) WHERE status IN ('COMPLETED','FAILED');
CREATE INDEX messages_recent ON ${s}.messages(application, accepted_at DESC, invocation_id);
CREATE INDEX reminders_due ON ${s}.reminders(application, due_at);
INSERT INTO ${s}.schema_version VALUES (1);
`,
    },
  ];
}
export async function migrateSchema({
  database,
  schema = 'brando_js',
  mode = 'apply-rolling-safe',
}: {
  database: Pool;
  schema?: string;
  mode?: SchemaManagement;
}): Promise<void> {
  schemaName(schema);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `brando.js:schema:${schema}`,
    ]);
    const exists = await client.query('SELECT to_regclass($1) AS name', [
      `${schema}.schema_version`,
    ]);
    if (exists.rows[0].name === null) {
      if (mode === 'validate-only')
        throw new UnsupportedSchema(`Schema ${schema} needs migration 1`);
      await client.query(schemaMigrations({ schema })[0]!.sql);
    } else {
      const current = await client.query(
        `SELECT max(version) AS version FROM ${schema}.schema_version`,
      );
      if (current.rows[0].version !== 1)
        throw new UnsupportedSchema(
          `Unsupported schema version ${current.rows[0].version}; expected 1`,
        );
    }
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }
}
