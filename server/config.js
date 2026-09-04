import path from 'node:path';
import fs from 'node:fs';

function intEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}
const str = (name, fallback = '') => (process.env[name] ?? fallback).trim();

const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

const dataDir = path.resolve(str('DATA_DIR') || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.resolve(str('DB_FILE') || path.join(dataDir, 'budget.db'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const webappUrl = str('WEBAPP_URL').replace(/\/+$/, '');

export const config = Object.freeze({
  nodeEnv,
  isProd,
  port: intEnv('PORT', 3000, 1, 65535),
  dataDir,
  dbPath,
  backupDir: path.resolve(str('BACKUP_DIR') || path.join(dataDir, 'backups')),
  backupKeep: intEnv('BACKUP_KEEP', 14, 1, 100),

  botToken: str('BOT_TOKEN').trim().replace(/^['\"]|['\"]$/g, '').replace(/\r|\n/g, ''),
  botMode: str('BOT_MODE', 'webhook') === 'polling' ? 'polling' : 'webhook',
  runBot: str('RUN_BOT', '1') !== '0',
  webhookSecret: str('TELEGRAM_WEBHOOK_SECRET'),
  webhookPath: '/telegram-webhook',
  webappUrl,

  allowedOrigin: (str('ALLOWED_ORIGIN') || webappUrl).replace(/\/+$/, ''),
  allowDevAuth: !isProd && str('ALLOW_DEV_AUTH', '0') === '1',

  geminiApiKey: str('GEMINI_API_KEY') || str('GOOGLE_API_KEY'),
  geminiModel: str('GEMINI_MODEL', 'gemini-2.0-flash'),
  aiTimeoutMs: intEnv('AI_TIMEOUT_MS', 25000, 3000, 120000),

  timezoneDefault: str('DEFAULT_TIMEZONE', 'Europe/Moscow'),
  maxBodyMb: intEnv('MAX_BODY_MB', 10, 1, 25),
  maxAiPerMinute: intEnv('MAX_AI_PER_MINUTE', 10, 1, 100),
  maxRequestsPerMinute: intEnv('MAX_REQUESTS_PER_MINUTE', 180, 10, 2000),
  maxTransactionsPerDay: intEnv('MAX_TRANSACTIONS_PER_DAY', 1000, 10, 10000),
  initDataMaxAgeSec: intEnv('INITDATA_MAX_AGE_SEC', 86400, 300, 604800),

  adminIds: new Set(
    str('ADMIN_TELEGRAM_IDS').split(',').map((x) => x.trim()).filter(Boolean)
  ),
});

export function assertConfig() {
  const problems = [];
  if (config.isProd && !config.botToken) problems.push('BOT_TOKEN обязателен в production');
  if (config.isProd && config.botMode === 'webhook') {
    if (config.webappUrl && !config.webappUrl.startsWith('https://')) {
      problems.push('WEBAPP_URL должен быть https://...');
    }
    if (config.webhookSecret && config.webhookSecret.length > 0 && config.webhookSecret.length < 16) {
      problems.push('TELEGRAM_WEBHOOK_SECRET: минимум 16 символов (или оставьте пустым)');
    }
  }
  if (config.isProd && config.allowDevAuth) problems.push('ALLOW_DEV_AUTH запрещён в production');
  if (problems.length) {
    console.error('Ошибки конфигурации:\n - ' + problems.join('\n - '));
    // Не валим процесс из‑за необязательного webhook secret
    const fatal = problems.some((p) => p.includes('BOT_TOKEN') || p.includes('WEBAPP_URL') || p.includes('ALLOW_DEV'));
    if (fatal) process.exit(1);
    else console.warn('Продолжаем с предупреждениями');
  }
}
