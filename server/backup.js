import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { config } from './config.js';

function ensureDir() {
  fs.mkdirSync(config.backupDir, { recursive: true });
}

/** Консистентная копия через SQLite Online Backup API */
export async function createBackup() {
  try {
    ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(config.backupDir, `budget-${stamp}.db`);
    await db.backup(dest);

    const files = fs
      .readdirSync(config.backupDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ f, t: fs.statSync(path.join(config.backupDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const extra of files.slice(config.backupKeep)) {
      fs.unlinkSync(path.join(config.backupDir, extra.f));
    }
    return { ok: true, file: path.basename(dest), at: stamp };
  } catch (e) {
    console.error('createBackup', e);
    return { ok: false, error: 'Не удалось создать бэкап' };
  }
}

export function listBackups() {
  ensureDir();
  return fs
    .readdirSync(config.backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(config.backupDir, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

export function backupFilePath(name) {
  if (!/^budget-[\dT\-]+\.db$/.test(name)) return null;
  const p = path.join(config.backupDir, name);
  return fs.existsSync(p) ? p : null;
}

/** Ежедневный бэкап около 03:00 по времени сервера */
export function startDailyBackupScheduler() {
  let lastDay = -1;
  const timer = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 3 && now.getDate() !== lastDay) {
      lastDay = now.getDate();
      const r = await createBackup();
      console.log('Daily backup:', r);
    }
  }, 60_000);
  timer.unref();
  return timer;
}
