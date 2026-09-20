import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const schema = `browser_${randomUUID().replaceAll('-', '')}`;
const env = { ...process.env, BRANDO_SCHEMA: schema };
delete env.NO_COLOR;
const result = spawnSync('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando',
});
try {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
} finally {
  await pool.end();
}
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
