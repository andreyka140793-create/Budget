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
app.use(express.json({ limit: '2mb' }));

// API
app.use('/api', routes);

// Health
app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Mini App: сначала dist (если собран), иначе исходники webapp (без Vite)
const webDist = path.join(__dirname, '..', 'webapp', 'dist');
const webSrc = path.join(__dirname, '..', 'webapp');
const useDist = fs.existsSync(path.join(webDist, 'index.html'));
const webRoot = useDist ? webDist : webSrc;

console.log(`Static Mini App from: ${webRoot} (${useDist ? 'dist' : 'source'})`);

app.use(express.static(webRoot));
// на случай path /src при раздаче из webapp/
if (!useDist) {
  app.use('/src', express.static(path.join(webSrc, 'src')));
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(webRoot, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Mini App files missing');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Дзен-бюджет API: http://localhost:${PORT}`);
  console.log(`Mini App:       http://localhost:${PORT}/`);
  startDailyBackupScheduler();
});

// Бот в том же процессе
if (process.env.BOT_TOKEN && process.env.RUN_BOT !== '0') {
  import('../bot/index.js').then((m) => m.startBot()).catch((e) => console.warn('Bot not started:', e.message));
}
