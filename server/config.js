import path from 'node:path';
import fs from 'node:fs';

const rootDir = path.resolve(process.env.DATA_DIR || (process.env.AMVERA === '1' ? '/data' : path.join(process.cwd(), 'data')));
fs.mkdirSync(rootDir, { recursive: true });
const resolvedDbPath = path.resolve(process.env.DB_FILE || path.join(rootDir, 'budget.db'));
fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

function intEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intEnv('PORT', 3000, 1, 65535),
  dataDir: rootDir,
  dbPath: resolvedDbPath,
  backupDir: path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(resolvedDbPath), 'backups')),
  botToken: (process.env.BOT_TOKEN || '').trim(),
  webhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim(),
  webappUrl: (process.env.WEBAPP_URL || '').replace(/\/$/, ''),
  botMode: process.env.BOT_MODE || 'webhook',
  allowedOrigin: (process.env.ALLOWED_ORIGIN || process.env.WEBAPP_URL || '').replace(/\/$/, ''),
  geminiApiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim(),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  timezoneDefault: process.env.DEFAULT_TIMEZONE || 'Europe/Warsaw',
  maxBodyMb: intEnv('MAX_BODY_MB', 10, 1, 25),
  maxAiPerMinute: intEnv('MAX_AI_PER_MINUTE', 10, 1, 100),
  maxRequestsPerMinute: intEnv('MAX_REQUESTS_PER_MINUTE', 120, 10, 1000),
  maxTransactionsPerDay: intEnv('MAX_TRANSACTIONS_PER_DAY', 1000, 10, 10000),
  backupAdminIds: new Set((process.env.BACKUP_ADMIN_IDS || '').split(',').map(x=>x.trim()).filter(Boolean)),
});
