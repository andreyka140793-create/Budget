import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import router from './routes.js';
import { startDailyBackupScheduler } from './backup.js';
import { startBot, getWebhookMiddleware, startReminderScheduler } from '../bot/index.js';
import db from './db.js';

const app=express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY==='1' ? 1 : false);

const allowedOrigin=config.allowedOrigin;
app.use(cors({origin:(origin,cb)=>{if(!origin)return cb(null,true);if(allowedOrigin&&origin===allowedOrigin)return cb(null,true);if(config.nodeEnv!=='production'&&!allowedOrigin)return cb(null,true);return cb(new Error('CORS origin denied'));},methods:['GET','POST','DELETE','OPTIONS'],allowedHeaders:['Content-Type','X-Telegram-Init-Data','Idempotency-Key']}));
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');next();});
app.use(express.json({limit:`${config.maxBodyMb}mb`,strict:true}));

const webRoot=path.join(process.cwd(),'webapp','dist');
const fallbackRoot=path.join(process.cwd(),'webapp');
app.use('/api',router);

app.get('/health',(req,res)=>res.json({ok:true,db:db.open?'up':'unknown',time:new Date().toISOString()}));
app.get('/readiness',(req,res)=>res.json({ready:true}));

// Telegram webhook: Telegram itself sends the update. Require the secret token header.
app.post('/telegram-webhook',(req,res,next)=>{
  if(!config.webhookSecret)return res.status(503).json({error:'Webhook secret is not configured'});
  if(req.get('X-Telegram-Bot-Api-Secret-Token')!==config.webhookSecret)return res.status(401).json({error:'Unauthorized'});
  const middleware=getWebhookMiddleware();
  if(!middleware)return res.status(503).json({error:'Bot is not initialized'});
  return middleware(req,res,next);
});

const staticRoot=fs.existsSync(webRoot)?webRoot:fallbackRoot;
// The app is served as source when a prebuilt dist is not present. In that mode
// Telegram WebView caching can otherwise keep an old main.js for a long time.
app.use(express.static(staticRoot,{
  index:'index.html',
  etag:true,
  maxAge:0,
  setHeaders:(res,filePath)=>{
    if (filePath.endsWith('index.html') || /\.(js|css|html)$/.test(filePath)) {
      res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma','no-cache');
      res.setHeader('Expires','0');
    }
  }
}));
app.get('*',(req,res,next)=>{if(req.path.startsWith('/api')||req.path==='/telegram-webhook')return next();res.sendFile(path.join(staticRoot,'index.html'));});

app.use((err,req,res,next)=>{console.error('HTTP error',err);if(res.headersSent)return next(err);res.status(500).json({error:'Внутренняя ошибка сервера'});});

const server=app.listen(config.port,()=>console.log(`Budget server listening on :${config.port}`));
startDailyBackupScheduler();

if(process.env.RUN_BOT!=='0'){
  startBot(config.botMode).then(()=>startReminderScheduler()).catch(e=>console.error('Bot startup failed',e));
}

process.once('SIGINT',()=>server.close(()=>process.exit(0)));
process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
export default app;
