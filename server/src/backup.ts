import fs from 'node:fs';
import path from 'node:path';
import { snapshot, type DB } from './db.ts';

const todayStamp = () => new Date().toISOString().slice(0, 10);

/** Writes backups/scheduler-YYYY-MM-DD.db once per day and prunes to the newest `keep`. */
export function runBackup(db: DB, dataDir: string, keep: number): string | null {
  const dir = path.join(dataDir, 'backups');
  const target = path.join(dir, `scheduler-${todayStamp()}.db`);
  if (fs.existsSync(target)) return null;
  snapshot(db, target);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^scheduler-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, old));
  return target;
}

/** Take a snapshot now (if today's is missing) and re-check hourly. */
export function scheduleBackups(db: DB, dataDir: string, keep: number, log: (msg: string) => void): NodeJS.Timeout {
  const tick = () => {
    try {
      const made = runBackup(db, dataDir, keep);
      if (made) log(`Backup written: ${made}`);
    } catch (e) {
      log(`Backup FAILED: ${(e as Error).message}`);
    }
  };
  tick();
  const t = setInterval(tick, 60 * 60 * 1000);
  t.unref();
  return t;
}
