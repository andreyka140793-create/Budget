import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import routes from './routes.js';
import { startDailyBackupScheduler } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '12mb' }));

// Telegram webhook (до JSON-парсера для raw? grammY express ok with json)
// Подключим после старта бота

// API
app.use('/api', routes);

// Health
app.get('/health', (_, res) =>
  res.json({
    ok: true,
    time: new Date().toISOString(),
    bot: Boolean(process.env.BOT_TOKEN),
    webapp: process.env.WEBAPP_URL || null,
  })
);

// Mini App static
const webDist = path.join(__dirname, '..', 'webapp', 'dist');
const webSrc = path.join(__dirname, '..', 'webapp');
const useDist = fs.existsSync(path.join(webDist, 'index.html'));
const webRoot = useDist ? webDist : webSrc;
console.log(`Static Mini App from: ${webRoot} (${useDist ? 'dist' : 'source'})`);

app.use(express.static(webRoot));
if (!useDist) {
  app.use('/src', express.static(path.join(webSrc, 'src')));
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/telegram-webhook')) return next();
  const indexPath = path.join(webRoot, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Mini App files missing');
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`API http://0.0.0.0:${PORT}`);
  startDailyBackupScheduler();

  if (process.env.BOT_TOKEN && process.env.RUN_BOT !== '0') {
    try {
      const botMod = await import('../bot/index.js');
      const mode = process.env.BOT_MODE || 'webhook';
      await botMod.startBot(mode);
      const wh = botMod.getWebhookMiddleware();
      if (wh) {
        app.post('/telegram-webhook', wh);
        console.log('Webhook route /telegram-webhook ready');
      }
    } catch (e) {
      console.error('Bot failed:', e);
    }
  } else {
    console.warn('Bot skipped (BOT_TOKEN / RUN_BOT)');
  }
});
