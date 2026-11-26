import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { ensureAdmin } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';

export interface TestApp {
  app: FastifyInstance;
  db: DB;
  cookie: string;
  call: (method: string, url: string, payload?: unknown, opts?: { anon?: boolean }) => Promise<{ status: number; body: any }>;
}

export async function makeApp(): Promise<TestApp> {
  const db = openDb(':memory:');
  const config = loadConfig({ DATA_DIR: './data-test', COOKIE_SECURE: 'false', WEB_DIR: './nonexistent' });
  ensureAdmin(db, 'admin', 'correct-horse-battery');
  const app = await buildApp(db, config);
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const set = login.headers['set-cookie'];
  const cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0]!;
  const call: TestApp['call'] = async (method, url, payload, opts) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: payload as object | undefined,
      headers: opts?.anon ? {} : { cookie },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { app, db, cookie, call };
}
