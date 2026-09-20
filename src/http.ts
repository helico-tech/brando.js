import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  BrandoError,
  DatabaseError,
  InvocationIdConflict,
  InvocationNotFound,
  RuntimeClosed,
  json,
} from './model.js';
import type { Brando, PageOptions } from './runtime.js';

export type Permission = 'read' | 'write' | false;
export interface OperationsOptions {
  runtime: Brando;
  authorize: (request: Request) => Permission | Promise<Permission>;
  basePath?: string;
  maxBodyBytes?: number;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const response = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
async function body(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new HttpError(415, 'Use application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'JSON body required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request body is too large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const submitSchema = z
  .object({
    actorType: z.string(),
    id: z.json(),
    messageType: z.string(),
    payload: z.json(),
    invocationId: z.string().optional(),
  })
  .strict();
/** A standard Fetch handler. Authentication is deliberately supplied by the host application. */
export function createOperationsHandler({
  runtime,
  authorize,
  basePath = '/api/brando',
  maxBodyBytes = 1048576,
}: OperationsOptions) {
  if (!basePath.startsWith('/') || basePath.endsWith('/'))
    throw new BrandoError('basePath must start with / and have no trailing /');
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${basePath}/`)) return response({ error: 'Not found' }, 404);
      const route = url.pathname.slice(basePath.length);
      const permission = await authorize(request);
      if (!permission) return response({ error: 'Authentication required' }, 401);
      const mutation = request.method !== 'GET' && request.method !== 'HEAD';
      if (mutation) {
        if (permission !== 'write') return response({ error: 'Write permission required' }, 403);
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin)
          return response({ error: 'Cross-origin mutation rejected' }, 403);
      }
      const options: PageOptions = {
        limit: Number(url.searchParams.get('limit') ?? 50),
        offset: Number(url.searchParams.get('offset') ?? 0),
        actorType: url.searchParams.get('actorType') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
        search: url.searchParams.get('search') ?? undefined,
      };
      if (request.method === 'GET') {
        if (route === '/session') return response({ permission });
        if (route === '/health/live') {
          const health = await runtime.health();
          return response({ live: health.live }, health.live ? 200 : 503);
        }
        if (route === '/health/ready') {
          const health = await runtime.health();
          return response(health, health.ready ? 200 : 503);
        }
        if (route === '/overview') return response(await runtime.overview());
        if (route === '/catalogue') return response(runtime.catalogue());
        if (route === '/actors') return response(await runtime.actors(options));
        if (route === '/actor') {
          const actorType = url.searchParams.get('type');
          const id = url.searchParams.get('id');
          if (!actorType || id === null) throw new HttpError(400, 'type and JSON id required');
          const actor = await runtime.inspectActor({ actorType, id: json(JSON.parse(id)) });
          return actor ? response(actor) : response({ error: 'Actor not found' }, 404);
        }
        if (route === '/invocations') return response(await runtime.invocations(options));
        if (route.startsWith('/invocations/')) {
          const item = await runtime.inspectInvocation(
            decodeURIComponent(route.slice('/invocations/'.length)),
          );
          return item ? response(item) : response({ error: 'Invocation not found' }, 404);
        }
        if (route === '/reminders') return response(await runtime.reminders(options));
        if (route === '/metrics') {
          const h = await runtime.health();
          return new Response(
            Object.entries(h.metrics)
              .map(
                ([name, value]) =>
                  `brando_${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_total ${value}`,
              )
              .join('\n') + '\n',
            {
              headers: { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' },
            },
          );
        }
      }
      if (request.method === 'POST' && route === '/submit') {
        const input = submitSchema.parse(await body(request, maxBodyBytes));
        return response({ invocationId: await runtime.submitJson(input) }, 202);
      }
      if (request.method === 'POST' && route === '/resubmit') {
        const input = z
          .object({ id: z.string(), invocationId: z.string().optional() })
          .strict()
          .parse(await body(request, maxBodyBytes));
        return response({ invocationId: await runtime.resubmit(input) }, 202);
      }
      return response(
        { error: request.method === 'GET' ? 'Not found' : 'Method or route not supported' },
        request.method === 'GET' ? 404 : 405,
      );
    } catch (error) {
      if (error instanceof HttpError) return response({ error: error.message }, error.status);
      if (error instanceof DatabaseError)
        return response(
          {
            error: error.name,
            retryable: error.retryable,
            ...('invocationId' in error ? { invocationId: error.invocationId } : {}),
          },
          503,
        );
      if (error instanceof RuntimeClosed) return response({ error: error.message }, 503);
      if (error instanceof InvocationIdConflict) return response({ error: error.message }, 409);
      if (error instanceof InvocationNotFound) return response({ error: error.message }, 404);
      if (
        error instanceof BrandoError ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof URIError
      )
        return response({ error: error.message }, 400);
      return response({ error: 'Internal operations error' }, 500);
    }
  };
}
export interface DashboardServerOptions extends OperationsOptions {
  dashboardDirectory?: string;
}
/** Serves the bundled dashboard and the operations API on a caller-owned Node HTTP server. */
export function createDashboardServer(options: DashboardServerOptions): Server {
  const api = createOperationsHandler(options);
  const directory = resolve(
    options.dashboardDirectory ?? fileURLToPath(new URL('./dashboard/', import.meta.url)),
  );
  return createServer(async (incoming, outgoing) => {
    try {
      const origin = `http://${incoming.headers.host ?? 'localhost'}`;
      const url = new URL(incoming.url ?? '/', origin);
      if (url.pathname.startsWith(`${options.basePath ?? '/api/brando'}/`)) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          bytes += (chunk as Buffer).length;
          if (bytes > (options.maxBodyBytes ?? 1048576)) {
            outgoing.writeHead(413, { 'content-type': 'application/json' });
            outgoing.end('{"error":"Request body is too large"}');
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const request = new Request(url, {
          method: incoming.method,
          headers,
          body: ['GET', 'HEAD'].includes(incoming.method ?? 'GET')
            ? undefined
            : Buffer.concat(chunks),
        });
        const result = await api(request);
        outgoing.writeHead(result.status, Object.fromEntries(result.headers));
        outgoing.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        outgoing.writeHead(405);
        outgoing.end();
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const path = resolve(directory, relative);
      if (!path.startsWith(directory + sep) || relative.includes('\0')) {
        outgoing.writeHead(404);
        outgoing.end();
        return;
      }
      let file: Buffer;
      try {
        file = await readFile(path);
      } catch {
        outgoing.writeHead(404);
        outgoing.end('Not found');
        return;
      }
      const mime = path.endsWith('.html')
        ? 'text/html'
        : path.endsWith('.js')
          ? 'text/javascript'
          : path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.svg')
              ? 'image/svg+xml'
              : 'application/octet-stream';
      outgoing.writeHead(200, {
        'content-type': `${mime}; charset=utf-8`,
        'x-content-type-options': 'nosniff',
        'cache-control': path.includes(`${sep}assets${sep}`)
          ? 'public,max-age=31536000,immutable'
          : 'no-cache',
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      });
      outgoing.end(incoming.method === 'HEAD' ? undefined : file);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end('Request failed');
    }
  });
}
