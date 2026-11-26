import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  adminUsername: string;
  adminPassword: string | null;
  cookieSecure: boolean;
  backupKeep: number;
  webDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'scheduler.db'),
    adminUsername: (env.ADMIN_USERNAME ?? 'admin').trim(),
    adminPassword: env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD : null,
    cookieSecure: (env.COOKIE_SECURE ?? 'true') !== 'false',
    backupKeep: Number(env.BACKUP_KEEP ?? 14),
    webDir: path.resolve(env.WEB_DIR ?? './web/dist'),
  };
}
