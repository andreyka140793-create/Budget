import { Router } from 'express';
import { config } from './config.js';
import db, { getOrCreateUser } from './db.js';
import { validateInitData, devUser } from './auth.js';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from './errors.js';
import { rateLimit } from './rateLimit.js';
import { clampInt } from './validation.js';
import * as svc from './service.js';
import * as ai from './ai.js';
import { createBackup, listBackups } from './backup.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- аутентификация ---------- */
router.use((req, res, next) => {
  try {
    const initData = String(
      req.headers['x-telegram-init-data'] ||
      req.headers['x-telegram-initdata'] ||
      ''
    ).trim();
    const tgUser = validateInitData(initData) || devUser(initData);
    if (!tgUser?.id) {
      const hint = !initData || initData === 'dev'
        ? 'Нет initData. Откройте Mini App кнопкой бота (/start → Открыть бюджет), не по прямой ссылке.'
        : 'Подпись Telegram не совпала. Проверьте BOT_TOKEN на Amvera (тот же, что у @BotFather, без пробелов).';
      throw unauthorized(hint);
    }
    req.tgUser = tgUser;
    req.user = getOrCreateUser(tgUser.id, tgUser.first_name || tgUser.username || '');
    req.isAdmin = config.adminIds.has(String(tgUser.id));
    next();
  } catch (e) {
    next(e);
  }
});

router.use(rateLimit({ scope: 'api', max: config.maxRequestsPerMinute }));
const aiLimit = rateLimit({ scope: 'ai', max: config.maxAiPerMinute, message: 'Слишком много распознаваний. Подождите минуту.' });
const writeLimit = rateLimit({ scope: 'write', max: 60, message: 'Слишком много изменений. Подождите минуту.' });

const requireAdmin = (req, res, next) => (req.isAdmin ? next() : next(forbidden('Только для администратора')));

/* ---------- дашборд и статистика ---------- */
router.get('/dashboard', wrap((req, res) => res.json(svc.dashboard(req.user))));

router.get('/stats/months', wrap((req, res) => {
  const months = clampInt(req.query.months, 6, 1, 24);
  res.json(svc.statsMonths(req.user, months));
}));

/* ---------- категории ---------- */
router.get('/categories', wrap((req, res) => res.json(svc.categoryList(req.user.id, req.query.type))));
router.post('/categories', writeLimit, wrap((req, res) => res.json(svc.createCategory(req.user.id, req.body || {}))));
router.delete('/categories/:id', writeLimit, wrap((req, res) => res.json(svc.deleteCategory(req.user.id, req.params.id))));

/* ---------- счета ---------- */
router.get('/accounts', wrap((req, res) => res.json(svc.accountList(req.user.id))));
router.post('/accounts', writeLimit, wrap((req, res) => res.json(svc.createAccount(req.user.id, req.body || {}))));
router.delete('/accounts/:id', writeLimit, wrap((req, res) => res.json(svc.deleteAccount(req.user.id, req.params.id))));

/* ---------- переводы ---------- */
router.get('/transfers', wrap((req, res) => res.json(svc.listTransfers(req.user.id, clampInt(req.query.limit, 50, 1, 200)))));
router.post('/transfers', writeLimit, wrap((req, res) => res.json(svc.createTransfer(req.user, req.body || {}))));
router.delete('/transfers/:id', writeLimit, wrap((req, res) => res.json(svc.deleteTransfer(req.user.id, req.params.id))));
// совместимость со старым фронтом
router.post('/accounts/transfer', writeLimit, wrap((req, res) => res.json(svc.createTransfer(req.user, req.body || {}))));

/* ---------- операции ---------- */
router.get('/transactions', wrap((req, res) => {
  const limit = clampInt(req.query.limit, 50, 1, 200);
  const offset = clampInt(req.query.offset, 0, 0, 100000);
  res.json(svc.listTransactions(req.user.id, limit, offset));
}));
router.post('/transactions', writeLimit, wrap((req, res) => res.json(svc.createTransaction(req.user, req.body || {}))));
router.delete('/transactions/:id', writeLimit, wrap((req, res) => res.json(svc.deleteTransaction(req.user.id, req.params.id))));

/* ---------- лимиты ---------- */
router.get('/budgets', wrap((req, res) => res.json(svc.budgetList(req.user))));
router.post('/budgets', writeLimit, wrap((req, res) => res.json(svc.setBudget(req.user, req.body || {}))));
router.delete('/budgets/:categoryId', writeLimit, wrap((req, res) => res.json(svc.deleteBudget(req.user.id, req.params.categoryId))));

/* ---------- копилки ---------- */
router.get('/piggies', wrap((req, res) => res.json(svc.piggyList(req.user.id))));
router.post('/piggies', writeLimit, wrap((req, res) => res.json(svc.createPiggy(req.user.id, req.body || {}))));
router.post('/piggies/:id/deposit', writeLimit, wrap((req, res) => res.json(svc.piggyOp(req.user.id, req.params.id, 'deposit', req.body || {}))));
router.post('/piggies/:id/withdraw', writeLimit, wrap((req, res) => res.json(svc.piggyOp(req.user.id, req.params.id, 'withdraw', req.body || {}))));
router.delete('/piggies/:id', writeLimit, wrap((req, res) => res.json(svc.deletePiggy(req.user.id, req.params.id))));

/* ---------- настройки ---------- */
router.get('/settings', wrap((req, res) => res.json(svc.getSettings(req.user, req.isAdmin))));
router.post('/settings', writeLimit, wrap((req, res) => res.json(svc.updateSettings(req.user, req.body || {}))));

/* ---------- распознавание (только черновик, без записи) ---------- */
router.post('/parse-sms', aiLimit, wrap(async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 2000).trim();
  if (text.length < 4) throw badRequest('Слишком короткий текст');

  const categories = svc.categoryList(req.user.id);
  const today = svc.todayIn(svc.tzOf(req.user));

  const { parseBankSms } = await import('./smsParse.js');
  const { suggestCategory } = await import('./categorize.js');

  const sms = parseBankSms(text);
  if (sms) {
    const sug = suggestCategory(`${sms.merchant} ${sms.raw}`, sms.type, categories);
    return res.json({
      amount: sms.amount, type: sms.type, note: sms.merchant || sms.raw.slice(0, 80),
      date: today, category_id: sug.category_id, category_name: sug.category_name, source: 'sms',
    });
  }

  if (!ai.isAiEnabled()) throw badRequest('Не удалось распознать SMS');
  const g = await ai.parseTransactionText(text, categories.map((c) => c.name), today);
  if (!g) throw badRequest('Не удалось распознать SMS');
  const cat = svc.resolveCategoryByName(req.user.id, g.type, g.category_name);
  res.json({ ...g, ...cat, date: g.date || today, source: 'ai' });
}));

router.post('/parse-receipt', aiLimit, wrap(async (req, res) => {
  if (!ai.isAiEnabled()) throw badRequest('Распознавание чеков не настроено на сервере');
  const names = svc.categoryList(req.user.id).map((c) => c.name);
  const today = svc.todayIn(svc.tzOf(req.user));
  const { image, text, pdfBase64 } = req.body || {};

  let draft = null;
  if (typeof image === 'string' && image.startsWith('data:image')) {
    draft = await ai.parseReceiptImage(image, names, today);
  } else if (typeof text === 'string' && text.trim().length > 10) {
    draft = await ai.parseReceiptText(text, names, today);
  } else if (typeof pdfBase64 === 'string' && pdfBase64.length > 100) {
    const { pdfToImageDataUrls, extractPdfText } = await import('./pdfImages.js');
    const buf = Buffer.from(pdfBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    for (const img of pdfToImageDataUrls(buf)) {
      try {
        draft = await ai.parseReceiptImage(img, names, today);
        if (draft) break;
      } catch (e) { console.warn('pdf image', e.message); }
    }
    if (!draft) {
      const extracted = extractPdfText(buf);
      if (extracted.length > 10) draft = await ai.parseReceiptText(extracted, names, today);
    }
    if (!draft) throw badRequest('Не удалось распознать PDF. Попробуйте фото страницы чека.');
  } else {
    throw badRequest('Нужно изображение, текст или PDF');
  }

  if (!draft) throw badRequest('Не удалось распознать чек');
  const cat = svc.resolveCategoryByName(req.user.id, draft.type, draft.category_name);
  res.json({ ...draft, ...cat, date: draft.date || today, source: 'receipt' });
}));

router.post('/ask', aiLimit, wrap(async (req, res) => {
  if (!ai.isAiEnabled()) throw badRequest('AI-помощник не настроен на сервере');
  const question = String(req.body?.question || '').slice(0, 500).trim() || 'Кратко оцени бюджет за месяц';
  res.json({ answer: await ai.askBudget(question, svc.summaryForAi(req.user)) });
}));

/* ---------- админ: бэкапы ---------- */
router.post('/backup', requireAdmin, wrap(async (req, res) => res.json(await createBackup())));
router.get('/backups', requireAdmin, wrap((req, res) => res.json(listBackups())));

/* ---------- 404 и ошибки ---------- */
router.use((req, res) => res.status(404).json({ error: 'Метод API не найден' }));

router.use((err, req, res, _next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'Такая запись уже существует' });
  }
  console.error('API error', req.method, req.path, err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

export default router;
