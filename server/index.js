import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import routes from './routes.js';
import { startDailyBackupScheduler } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API
app.use('/api', routes);

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Mini App static (после npm run build:web → webapp/dist)
const webDist = path.join(__dirname, '..', 'webapp', 'dist');
app.use(express.static(webDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Mini App not built. Run: cd webapp && npm i && npm run build');
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Дзен-бюджет API: http://localhost:${PORT}`);
  console.log(`Mini App:       http://localhost:${PORT}/`);
  startDailyBackupScheduler();
});

// Опционально: бот в том же процессе
if (process.env.BOT_TOKEN && process.env.RUN_BOT !== '0') {
  import('../bot/index.js').then((m) => m.startBot()).catch((e) => console.warn('Bot not started:', e.message));
}
