import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import db from './db.js';

function ensureDir(){fs.mkdirSync(config.backupDir,{recursive:true});}

export function createBackup(){
  ensureDir();
  const stamp=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const dest=path.join(config.backupDir,`budget-${stamp}.db`);
  try{
    db.pragma('wal_checkpoint(PASSIVE)');
    // better-sqlite3 backup is async; for the synchronous HTTP endpoint we use VACUUM INTO.
    // The destination is unique, so the operation is atomic from the app's perspective.
    db.prepare('VACUUM INTO ?').run(dest);
    const files=fs.readdirSync(config.backupDir).filter(f=>/^budget-.*\.db$/.test(f)).map(f=>({f,t:fs.statSync(path.join(config.backupDir,f)).mtimeMs})).sort((a,b)=>b.t-a.t);
    for(const extra of files.slice(14))fs.unlinkSync(path.join(config.backupDir,extra.f));
    return {ok:true,file:path.basename(dest),at:stamp};
  }catch(e){try{if(fs.existsSync(dest))fs.unlinkSync(dest);}catch{};return {ok:false,error:e.message};}
}

export function listBackups(){ensureDir();return fs.readdirSync(config.backupDir).filter(f=>/^budget-.*\.db$/.test(f)).map(f=>{const s=fs.statSync(path.join(config.backupDir,f));return {file:f,size:s.size,mtime:s.mtime.toISOString()};}).sort((a,b)=>b.mtime.localeCompare(a.mtime));}

export function startDailyBackupScheduler(){let last='';setInterval(()=>{const d=new Date();const key=d.toISOString().slice(0,10);if(d.getHours()===3&&d.getMinutes()<2&&last!==key){last=key;console.log('Daily backup:',createBackup());}},60_000).unref();}
