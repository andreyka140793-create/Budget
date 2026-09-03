import { Router } from 'express';
import db, { ensureUser, getUserById, getUsersForReminder, getDaySummary, todayForUser, toCents, fromCents } from './db.js';
import { validateInitData } from './auth.js';
import { createBackup, listBackups } from './backup.js';
import { suggestCategory } from './categorize.js';
import { parseBankSms } from './smsParse.js';
import { isGeminiEnabled, parseReceiptImage, parseReceiptText, parseTransactionWithAI, askBudgetAI } from './gemini.js';
import { pdfToImageDataUrls, extractPdfText } from './pdfImages.js';
import { rateLimit } from './rateLimit.js';
import { clampInt, requireColor, requireDate, requireInt, requireName, requireNote, requirePositiveCents, requireType } from './validation.js';
import { accountList, categoryList, createTransaction, createTransfer, dashboard, deleteTransaction, deleteTransfer, getAccountOwned, getCategoryOwned, listTransactions, monthBounds, statsMonths, monthSummaryForAi } from './finance.js';
import { config } from './config.js';

const router = Router();

function safeError(res, status, message) { return res.status(status).json({ error: message }); }

function auth(req,res,next){
  const initData=String(req.headers['x-telegram-init-data']||'');
  const user=validateInitData(initData,config.botToken,{allowDev:process.env.NODE_ENV!=='production'});
  if(!user?.id) return safeError(res,401,'Telegram авторизация не подтверждена. Откройте приложение из бота.');
  try{
    req.tgUser=user;
    req.user=ensureUser(user.id,user.first_name||user.username||'');
    next();
  }catch(e){ console.error('auth error',e); safeError(res,500,'Ошибка авторизации'); }
}

router.use(auth);
router.use(rateLimit({max:config.maxRequestsPerMinute,scope:'api'}));

router.get('/dashboard',(req,res)=>{ try{res.json(dashboard(req.user.id,req.user));}catch(e){console.error('/dashboard',e);safeError(res,500,'Не удалось загрузить бюджет');} });

router.get('/stats/months',(req,res)=>{try{const months=clampInt(req.query.months,6,1,12);res.json(statsMonths(req.user.id,months,req.user.timezone));}catch(e){safeError(res,500,'Не удалось загрузить статистику');}});

router.get('/categories',(req,res)=>{const type=req.query.type==='income'||req.query.type==='expense'?req.query.type:null;res.json(categoryList(req.user.id,type));});
router.post('/categories',(req,res)=>{try{
  const name=requireName(req.body?.name,'name',50), type=requireType(req.body?.type), icon=String(req.body?.icon||'💰').slice(0,8), color=requireColor(req.body?.color);
  const info=db.prepare('INSERT INTO categories(user_id,name,type,icon,color) VALUES(?,?,?,?,?)').run(req.user.id,name,type,icon,color);
  res.status(201).json(db.prepare('SELECT * FROM categories WHERE id=? AND user_id=?').get(info.lastInsertRowid,req.user.id));
}catch(e){safeError(res,400,e.message);}});

router.get('/budgets',(req,res)=>{
  const {from,to}=monthBounds();
  const rows=db.prepare(`SELECT b.*,c.name,c.icon,c.color,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.user_id=b.user_id AND t.category_id=b.category_id AND t.type='expense' AND t.kind='normal' AND t.date BETWEEN ? AND ?),0) spent FROM budgets b JOIN categories c ON c.id=b.category_id AND c.user_id=b.user_id AND c.type='expense' WHERE b.user_id=?`).all(from,to,req.user.id);
  res.json(rows.map(r=>({...r,amount:fromCents(r.amount),spent:fromCents(r.spent)})));
});
router.post('/budgets',(req,res)=>{try{
  const categoryId=requireInt(req.body?.category_id,'category_id'); const amount=requirePositiveCents(toCents(req.body?.amount),'amount',100000000000);
  if(!getCategoryOwned(req.user.id,categoryId,'expense')) return safeError(res,404,'Категория не найдена');
  db.prepare(`INSERT INTO budgets(user_id,category_id,amount) VALUES(?,?,?) ON CONFLICT(user_id,category_id) DO UPDATE SET amount=excluded.amount`).run(req.user.id,categoryId,amount);
  const {from,to}=monthBounds();
  const row=db.prepare(`SELECT b.*,c.name,c.icon,c.color,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.user_id=b.user_id AND t.category_id=b.category_id AND t.type='expense' AND t.kind='normal' AND t.date BETWEEN ? AND ?),0) spent FROM budgets b JOIN categories c ON c.id=b.category_id AND c.user_id=b.user_id WHERE b.user_id=? AND b.category_id=?`).get(from,to,req.user.id,categoryId);
  res.json({...row,amount:fromCents(row.amount),spent:fromCents(row.spent)});
}catch(e){safeError(res,400,e.message);}});
router.delete('/budgets/:categoryId',(req,res)=>{try{const cid=requireInt(req.params.categoryId,'category_id');db.prepare('DELETE FROM budgets WHERE user_id=? AND category_id=?').run(req.user.id,cid);res.json({ok:true});}catch(e){safeError(res,400,e.message);}});

router.get('/accounts',(req,res)=>res.json(accountList(req.user.id)));
router.post('/accounts',(req,res)=>{try{
  const name=requireName(req.body?.name,'name',40);const type=['cash','card','other'].includes(req.body?.type)?req.body.type:'card';const icon=String(req.body?.icon||(type==='cash'?'💵':'💳')).slice(0,8);
  const info=db.prepare('INSERT INTO accounts(user_id,name,type,balance,icon) VALUES(?,?,?,0,?)').run(req.user.id,name,type,icon);res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?').get(info.lastInsertRowid,req.user.id));
}catch(e){safeError(res,400,e.message);}});
router.delete('/accounts/:id',(req,res)=>{try{
  const id=requireInt(req.params.id,'account_id');const acc=getAccountOwned(req.user.id,id);if(!acc)return safeError(res,404,'Счёт не найден');
  const count=db.prepare('SELECT COUNT(*) c FROM accounts WHERE user_id=?').get(req.user.id).c;if(count<=1)return safeError(res,400,'Нужен хотя бы один счёт');
  const linked=db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=? AND account_id=?').get(req.user.id,id).c;if(linked>0)return safeError(res,400,'Нельзя удалить счёт с операциями. Сначала перенесите или удалите операции.');
  db.prepare('DELETE FROM accounts WHERE id=? AND user_id=?').run(id,req.user.id);res.json({ok:true});
}catch(e){safeError(res,400,e.message);}});

router.post('/accounts/transfer',(req,res)=>{try{const id=createTransfer(req.user.id,{...req.body,date:req.body?.date||todayForUser(req.user)});const t=db.prepare('SELECT * FROM transfers WHERE id=? AND user_id=?').get(id,req.user.id);res.status(201).json({id,from:accountList(req.user.id).find(a=>a.id===t.from_account_id),to:accountList(req.user.id).find(a=>a.id===t.to_account_id)});}catch(e){safeError(res,400,e.message);}});
router.delete('/transfers/:id',(req,res)=>{try{deleteTransfer(req.user.id,req.params.id);res.json({ok:true});}catch(e){safeError(res,400,e.message);}});

router.get('/transactions',(req,res)=>{const limit=clampInt(req.query.limit,50,1,200),offset=clampInt(req.query.offset,0,0,1000000);res.json(listTransactions(req.user.id,limit,offset));});
router.post('/transactions',(req,res)=>{try{
  const id=createTransaction(req.user.id,{...req.body,date:req.body?.date||todayForUser(req.user),idempotency_key:req.get('Idempotency-Key')||req.body?.idempotency_key});
  const row=listTransactions(req.user.id,200,0).find(x=>x.id===id);
  res.status(201).json(row);
}catch(e){safeError(res,400,e.message);}});
router.delete('/transactions/:id',(req,res)=>{try{deleteTransaction(req.user.id,req.params.id);res.json({ok:true});}catch(e){safeError(res,400,e.message);}});

router.get('/settings',(req,res)=>res.json({remind_enabled:Boolean(req.user.remind_enabled),remind_hour:req.user.remind_hour??21,timezone:req.user.timezone||config.timezoneDefault,name:req.user.name,currency:req.user.currency||'RUB'}));
router.post('/settings',(req,res)=>{try{
  const updates=[];const params=[];
  if(req.body?.remind_enabled!==undefined){if(typeof req.body.remind_enabled!=='boolean')throw new Error('remind_enabled: invalid');updates.push('remind_enabled=?');params.push(req.body.remind_enabled?1:0);}
  if(req.body?.remind_hour!==undefined){const h=Number(req.body.remind_hour);if(!Number.isInteger(h)||h<0||h>23)throw new Error('remind_hour: invalid');updates.push('remind_hour=?');params.push(h);}
  if(req.body?.timezone!==undefined){const tz=String(req.body.timezone);try{new Intl.DateTimeFormat('en-US',{timeZone:tz}).format();}catch{throw new Error('timezone: invalid');}if(tz.length>64)throw new Error('timezone: invalid');updates.push('timezone=?');params.push(tz);}
  if(updates.length){updates.push('updated_at=CURRENT_TIMESTAMP');params.push(req.user.id);db.prepare(`UPDATE users SET ${updates.join(',')} WHERE id=?`).run(...params);}
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);res.json({remind_enabled:Boolean(u.remind_enabled),remind_hour:u.remind_hour,timezone:u.timezone});
}catch(e){safeError(res,400,e.message);}});

router.get('/backup',(req,res)=>{if(!config.backupAdminIds.has(String(req.tgUser.id)))return safeError(res,403,'Доступ запрещён');res.json({ok:true,backups:listBackups()});});
router.post('/backup',(req,res)=>{if(!config.backupAdminIds.has(String(req.tgUser.id)))return safeError(res,403,'Доступ запрещён');try{const result=createBackup();if(!result.ok)return safeError(res,500,result.error||'Backup failed');res.json(result);}catch(e){safeError(res,500,'Не удалось создать бэкап');}});

const aiLimiter=rateLimit({max:config.maxAiPerMinute,scope:'ai',message:'Слишком много AI-запросов. Подождите минуту.'});
router.post('/parse-sms',aiLimiter,async(req,res)=>{
  const text=String(req.body?.text||'').trim();if(text.length<2||text.length>4000)return safeError(res,400,'Текст SMS должен быть от 2 до 4000 символов');
  const categories=categoryList(req.user.id);let parsed=parseBankSms(text);
  try{
    if(!parsed && isGeminiEnabled()) parsed=await parseTransactionWithAI(text,categories.filter(c=>c.type==='expense'||c.type==='income').map(c=>c.name));
    if(!parsed)return safeError(res,400,'Не удалось распознать SMS');
    const type=requireType(parsed.type);const amount=requirePositiveCents(toCents(parsed.amount),'amount',100000000000);
    const sug=suggestCategory(`${parsed.merchant||''} ${parsed.note||''} ${text}`,type,categories);
    const categoryId=sug.category_id;
    if(categoryId && !getCategoryOwned(req.user.id,categoryId,type))return safeError(res,400,'Категория не найдена');
    res.json({amount:fromCents(amount),type,category_id:categoryId,category_name:sug.category_name||null,merchant:String(parsed.merchant||parsed.note||'').slice(0,120),note:String(parsed.note||parsed.merchant||'').slice(0,120),date:parsed.date||null,source:parsed.source||'parser'});
  }catch(e){console.error('/parse-sms',e);safeError(res,500,'Не удалось обработать SMS');}
});


router.post('/ai/ask',aiLimiter,async(req,res)=>{
  if(!isGeminiEnabled())return safeError(res,503,'AI распознавание не настроено');
  const question=String(req.body?.question||'').trim();
  if(question.length<2||question.length>1000)return safeError(res,400,'Вопрос должен быть от 2 до 1000 символов');
  try{res.json({answer:(await askBudgetAI(question,monthSummaryForAi(req.user.id))).slice(0,4000)});}catch(e){console.error('/ai/ask',e);safeError(res,502,'AI временно недоступен');}
});

router.post('/parse-receipt',aiLimiter,async(req,res)=>{
  if(!isGeminiEnabled())return safeError(res,503,'AI распознавание не настроено');
  const categories=categoryList(req.user.id);const names=categories.map(c=>c.name);const {image,text,pdfBase64}=req.body||{};
  try{
    let parsed=null;
    if(typeof image==='string'&&/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)){if(image.length>9_500_000)throw new Error('Изображение слишком большое');parsed=await parseReceiptImage(image,names);}
    else if(typeof text==='string'&&text.trim().length>10){if(text.length>12000)throw new Error('Текст слишком большой');parsed=await parseReceiptText(text,names);}
    else if(typeof pdfBase64==='string'){
      const b64=pdfBase64.replace(/^data:application\/pdf;base64,/i,'');if(b64.length>10_000_000)throw new Error('PDF слишком большой');const buf=Buffer.from(b64,'base64');
      if(buf.length>7_500_000||buf.subarray(0,4).toString()!=='%PDF')throw new Error('Некорректный PDF');
      const imgs=pdfToImageDataUrls(buf,{maxImages:3,maxBytes:7_000_000});
      for(const img of imgs){try{parsed=await parseReceiptImage(img,names);if(parsed)break;}catch(e){console.warn('PDF vision:',e.message);}}
      if(!parsed){const extracted=extractPdfText(buf).slice(0,12000);if(extracted.length>10)parsed=await parseReceiptText(extracted,names);}
    } else return safeError(res,400,'Нужны фото, текст или PDF');
    if(!parsed)return safeError(res,400,'Не удалось распознать чек');
    const amount=requirePositiveCents(toCents(parsed.amount),'amount',100000000000);
    const type='expense';
    const found=categories.find(c=>c.type==='expense'&&c.name.toLowerCase()===String(parsed.category_name||'').toLowerCase())||categories.find(c=>c.type==='expense'&&c.name==='Прочее')||categories.find(c=>c.type==='expense');
    res.json({amount:fromCents(amount),type,category_id:found?.id??null,category_name:found?.name||'Прочее',note:String(parsed.note||'Чек').slice(0,120),date:parsed.date?requireDate(parsed.date):null,source:'receipt'});
  }catch(e){console.error('/parse-receipt',e);safeError(res,400,e.message||'Не удалось обработать чек');}
});

router.get('/piggies',(req,res)=>res.json(db.prepare('SELECT * FROM piggy_banks WHERE user_id=? ORDER BY id').all(req.user.id).map(p=>({...p,goal:fromCents(p.goal),balance:fromCents(p.balance)}))));
router.post('/piggies',(req,res)=>{try{const name=requireName(req.body?.name,'name',40);const goal=req.body?.goal?requirePositiveCents(toCents(req.body.goal),'goal',100000000000):0;const icon=String(req.body?.icon||'🏦').slice(0,8);const info=db.prepare('INSERT INTO piggy_banks(user_id,name,goal,balance,icon) VALUES(?,?,?,0,?)').run(req.user.id,name,goal,icon);const row=db.prepare('SELECT * FROM piggy_banks WHERE id=? AND user_id=?').get(info.lastInsertRowid,req.user.id);res.status(201).json({...row,goal:fromCents(row.goal),balance:0});}catch(e){safeError(res,400,e.message);}});
router.post('/piggies/:id/deposit',(req,res)=>piggyOp(req,res,1));
router.post('/piggies/:id/withdraw',(req,res)=>piggyOp(req,res,-1));
function piggyOp(req,res,direction){try{const id=requireInt(req.params.id,'piggy_id');const amount=requirePositiveCents(toCents(req.body?.amount),'amount',100000000000);const note=requireNote(req.body?.note||'');const piggy=db.prepare('SELECT * FROM piggy_banks WHERE id=? AND user_id=?').get(id,req.user.id);if(!piggy)return safeError(res,404,'Копилка не найдена');if(direction<0&&amount>piggy.balance)return safeError(res,400,'Недостаточно средств в копилке');
  db.transaction(()=>{db.prepare('UPDATE piggy_banks SET balance=balance+? WHERE id=? AND user_id=?').run(direction*amount,id,req.user.id);db.prepare('INSERT INTO piggy_ops(user_id,piggy_id,amount,note) VALUES(?,?,?,?)').run(req.user.id,id,direction*amount,note|| (direction>0?'Пополнение':'Снятие'));})();
  const row=db.prepare('SELECT * FROM piggy_banks WHERE id=? AND user_id=?').get(id,req.user.id);res.json({...row,goal:fromCents(row.goal),balance:fromCents(row.balance)});
}catch(e){safeError(res,400,e.message);}}
router.delete('/piggies/:id',(req,res)=>{try{const id=requireInt(req.params.id,'piggy_id');const changed=db.prepare('DELETE FROM piggy_banks WHERE id=? AND user_id=?').run(id,req.user.id);if(!changed.changes)return safeError(res,404,'Копилка не найдена');res.json({ok:true});}catch(e){safeError(res,400,e.message);}});

export { getUsersForReminder, getDaySummary };
export default router;
