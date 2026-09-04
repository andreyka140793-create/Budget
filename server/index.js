import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { config, assertConfig } from './config.js';
import { closeDb } from './db.js';
import routes from './routes.js';
import { startDailyBackupScheduler } from './backup.js';
import { startReminderScheduler } from './reminders.js';

assertConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://telegram.org'],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ['https://web.telegram.org', 'https://telegram.org'],
        'object-src': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Mini App открывается с того же origin — CORS почти не нужен.
// Разрешаем кастомный заголовок на случай отличия origin.
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'X-Telegram-InitData'],
  maxAge: 600,
}));

app.use(express.json({ limit: `${config.maxBodyMb}mb` }));

app.get('/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), env: config.nodeEnv, bot: Boolean(config.botToken) })
);

// ВРЕМЕННЫЙ диагностический маршрут — удалить после того, как разберёмся с 401.
// Открывается прямо в браузере телефона, ничего секретного не показывает —
// только SHA-256 отпечаток токена (первые 12 символов) и его длину.
app.get('/_debug/token-fingerprint', (req, res) => {
  if (req.query.key !== 'budzet-diag-2026') return res.status(404).send('Not found');
  const t = config.botToken || '';
  res.json({
    fingerprint: t ? crypto.createHash('sha256').update(t).digest('hex').slice(0, 12) : null,
    length: t.length,
    startsWithDigits: /^\d+/.test(t),
    webappUrl: config.webappUrl,
    botMode: config.botMode,
    nodeEnv: config.nodeEnv,
  });
});

app.use('/api', routes);

/* ---------- статика Mini App ---------- */
const webDist = path.join(__dirname, '..', 'webapp', 'dist');
const distReady = fs.existsSync(path.join(webDist, 'index.html'));

if (distReady) {
  app.use(
    express.static(webDist, {
      index: false,
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', /\.(js|css|woff2?|png|jpe?g|svg)$/.test(filePath)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache');
      },
    })
  );
} else if (config.isProd) {
  console.error('webapp/dist не собран. Запустите: npm run build:web');
} else {
  const webSrc = path.join(__dirname, '..', 'webapp');
  console.warn('dist не найден — раздаю исходники (только для разработки)');
  app.use(express.static(webSrc, { index: false }));
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === config.webhookPath) return next();
  const indexPath = distReady
    ? path.join(webDist, 'index.html')
    : path.join(__dirname, '..', 'webapp', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexPath);
  }
  res.status(503).send('Mini App не собран');
});

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Файл слишком большой' });
  console.error('Server error', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

/* ---------- запуск ---------- */
const server = http.createServer(app);
let botModule = null;

server.listen(config.port, '0.0.0.0', async () => {
  console.log(`API на порту ${config.port} (${config.nodeEnv})`);
  startDailyBackupScheduler();

  if (config.botToken && config.runBot) {
    try {
      botModule = await import('../bot/index.js');
      const middleware = await botModule.startBot(config.botMode);
      if (middleware) {
        app.post(config.webhookPath, middleware);
        console.log('Webhook-маршрут готов:', config.webhookPath);
      }
      startReminderScheduler(() => botModule?.getBot() ?? null);
      console.log('Планировщик напоминаний запущен');
    } catch (e) {
      console.error('Не удалось запустить бота:', e);
    }
  } else {
    console.warn('Бот не запущен (нет BOT_TOKEN или RUN_BOT=0)');
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: останавливаюсь…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try { await botModule?.stopBot?.(); } catch {}
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
