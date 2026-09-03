import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || (process.env.AMVERA === '1' ? '/data' : path.join(__dirname, '..', 'data'));
const dbPath = path.join(dataDir, 'budget.db');
const backupDir = path.join(dataDir, 'backups');

function ensureDir() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
}

export function createBackup() {
  try {
    ensureDir();
    if (!fs.existsSync(dbPath)) {
      return { ok: false, error: 'База ещё не создана' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupDir, `budget-${stamp}.db`);
    fs.copyFileSync(dbPath, dest);

    // Храним максимум 14 бэкапов
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const extra of files.slice(14)) {
      fs.unlinkSync(path.join(backupDir, extra.f));
    }

    return { ok: true, file: path.basename(dest), at: stamp };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function listBackups() {
  ensureDir();
  return fs.readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(backupDir, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** Ежедневный бэкап около 03:00 локального времени сервера */
export function startDailyBackupScheduler() {
  let lastDay = -1;
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 3 && now.getMinutes() < 2 && now.getDate() !== lastDay) {
      lastDay = now.getDate();
      const r = createBackup();
      console.log('Daily backup:', r);
    }
  }, 60_000);
}
