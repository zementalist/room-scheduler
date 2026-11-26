import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { makeRequireAdmin } from './auth.ts';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { HttpError } from './errors.ts';
import { registerImportExport } from './importExport.ts';
import { registerRoutes } from './routes.ts';

export interface AppContext {
  db: DB;
  config: Config;
  requireAdmin: ReturnType<typeof makeRequireAdmin>;
}

export async function buildApp(db: DB, config: Config, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1024 * 1024 });
  const ctx: AppContext = { db, config, requireAdmin: makeRequireAdmin(db) };

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.decorateRequest('adminUser', null);

  // Cross-site request forgery defence in depth (cookies are also SameSite=Lax):
  // a browser-supplied Origin on a state-changing request must match this host.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* fall through to rejection */
      }
      if (host !== req.headers.host) throw new HttpError(403, 'forbidden_origin', 'Cross-site request rejected.');
    }
  });

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Unexpected server error.' });
  });

  registerRoutes(app, ctx);
  registerImportExport(app, ctx);

  const indexHtml = path.join(config.webDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith('.html')) reply.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    });
  }
  return app;
}
