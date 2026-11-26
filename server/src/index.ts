import { buildApp } from './app.ts';
import { ensureAdmin } from './auth.ts';
import { scheduleBackups } from './backup.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
ensureAdmin(db, config.adminUsername, config.adminPassword);

const app = await buildApp(db, config, { logger: true });
scheduleBackups(db, config.dataDir, config.backupKeep, (m) => app.log.info(m));

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
