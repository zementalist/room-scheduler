import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tx, type DB } from './db.ts';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n) });
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Keeps the single admin account in sync with ADMIN_USERNAME / ADMIN_PASSWORD.
 * Changing the password in .env and restarting rotates it and signs out existing sessions.
 */
export function ensureAdmin(db: DB, username: string, password: string | null): void {
  const existing = db.prepare('SELECT username, password_hash FROM users').all() as {
    username: string;
    password_hash: string;
  }[];
  if (password === null) {
    if (existing.length === 0) {
      throw new Error('ADMIN_PASSWORD must be set to create the admin account on first start.');
    }
    return;
  }
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  const current = existing.find((u) => u.username === username);
  const onlyThisAdmin = existing.length === 1 && current !== undefined;
  if (onlyThisAdmin && verifyPassword(password, current.password_hash)) return;
  tx(db, () => {
    db.exec('DELETE FROM users'); // cascades to sessions; there is exactly one admin
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  });
}

/** A fixed-cost dummy verification so unknown usernames take as long as wrong passwords. */
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

export function checkLogin(db: DB, username: string, password: string): boolean {
  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as
    | { password_hash: string }
    | undefined;
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return ok && row !== undefined;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db: DB, username: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    username,
    Date.now() + SESSION_TTL_MS,
  );
  return token;
}

export function sessionUser(db: DB, token: string | undefined): string | null {
  if (!token) return null;
  const row = db.prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    | { username: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return row.username;
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

declare module 'fastify' {
  interface FastifyRequest {
    adminUser: string | null;
  }
}

/** preHandler for every mutating/admin route. */
export function makeRequireAdmin(db: DB) {
  return async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    const user = sessionUser(db, req.cookies[SESSION_COOKIE]);
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Admin login required.' });
    }
    req.adminUser = user;
  };
}
