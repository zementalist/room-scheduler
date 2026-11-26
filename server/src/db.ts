import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

/**
 * Ordered migrations. The index+1 is the schema version stored in PRAGMA user_version,
 * so a database is always upgraded forward and never silently re-initialised.
 */
const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE rooms (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    name_norm TEXT NOT NULL UNIQUE,
    building  TEXT NOT NULL DEFAULT '',
    capacity  INTEGER CHECK (capacity IS NULL OR capacity >= 0),
    type      TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE semesters (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    CHECK (start_date <= end_date)
  );
  CREATE UNIQUE INDEX one_current_semester ON semesters (is_current) WHERE is_current = 1;

  CREATE TABLE reservations (
    id          TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    course      TEXT NOT NULL DEFAULT '',
    cat         TEXT NOT NULL CHECK (cat IN ('schedule', 'event')),
    kind        TEXT NOT NULL CHECK (kind IN ('date', 'weekly')),
    date        TEXT,
    weekday     INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
    start_min   INTEGER NOT NULL,
    end_min     INTEGER NOT NULL,
    semester_id TEXT REFERENCES semesters (id) ON DELETE RESTRICT,
    CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min),
    CHECK (
      (kind = 'date'   AND date IS NOT NULL AND weekday IS NULL     AND semester_id IS NULL) OR
      (kind = 'weekly' AND date IS NULL     AND weekday IS NOT NULL AND semester_id IS NOT NULL)
    )
  );
  CREATE INDEX idx_reservations_room ON reservations (room_id);
  CREATE INDEX idx_reservations_semester ON reservations (semester_id);

  CREATE TABLE users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  if (version > MIGRATIONS.length) {
    throw new Error(`Database schema v${version} is newer than this application (v${MIGRATIONS.length}).`);
  }
  while (version < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
}

/** Run fn inside a write transaction (BEGIN IMMEDIATE) and roll back on any throw. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Consistent online snapshot (safe while the app is serving requests). */
export function snapshot(db: DB, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}
