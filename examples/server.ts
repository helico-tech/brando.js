import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { Brando } from '../src/index.js';
import { createDashboardServer } from '../src/http.js';
import { Acquire, StartSchedule } from '../src/primitives.js';
import { actors, Add, Counters, Jobs, Limits } from './actors.js';
const host = process.env.HOST ?? '127.0.0.1';
const token = process.env.BRANDO_TOKEN;
if (!token && !['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error('Set BRANDO_TOKEN before exposing the console outside loopback');
const runtime = await Brando.start({
  name: process.env.BRANDO_APPLICATION ?? 'brando-demo',
  database: process.env.DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando',
  actors,
  config: { schema: process.env.BRANDO_SCHEMA ?? 'brando_js' },
  onEvent: (event) => {
    if (event.kind === 'runtime-error') console.error(event);
  },
});
if (process.env.SEED_DEMO !== 'false') {
  for (const [id, amount] of [
    ['page-views', 128],
    ['orders-processed', 42],
    ['scheduled-events', 7],
    ['notifications', 63],
    ['api-requests', 256],
  ] as const)
    await runtime.call({
      target: Counters.ref(id),
      message: Add,
      payload: { amount },
      invocationId: `demo-seed:${id}:v1`,
    });
  await runtime.call({
    target: Limits.ref('api-client'),
    message: Acquire,
    payload: {},
    invocationId: 'demo-seed:rate-limit:v1',
  });
  await runtime.call({
    target: Jobs.ref('daily-summary'),
    message: StartSchedule,
    payload: { cadenceMillis: 60000 },
    invocationId: 'demo-seed:schedule:v1',
  });
}
const server = createDashboardServer({
  runtime,
  dashboardDirectory: resolve('dist/dashboard'),
  authorize: (request) => {
    if (!token) return 'write';
    const supplied = Buffer.from(
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
    );
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
      ? 'write'
      : false;
  },
});
server.listen(Number(process.env.PORT ?? 3000), host, () =>
  console.log(`Brando dashboard: http://${host}:${process.env.PORT ?? 3000} (${runtime.name})`),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeIdleConnections();
  await runtime.close();
}
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
