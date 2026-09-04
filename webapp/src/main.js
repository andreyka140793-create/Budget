const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  try { tg.disableVerticalSwipes?.(); } catch {}
  try { tg.requestFullscreen?.(); } catch {}
}

/* ---------- утилиты ---------- */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
const color = (v, fallback = '#5b8def') => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : fallback);
const fmt = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n || 0) + ' ₽';
const $ = (id) => document.getElementById(id);
const todayLocal = () => new Date().toLocaleDateString('sv-SE');
/** Дата с чека: не из будущего и не старше 1 года — иначе сегодня */
function clampReceiptDate(dateStr) {
  const today = todayLocal();
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return today;
  if (dateStr > today) return today;
  const d = new Date(dateStr + 'T12:00:00');
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  if (d < yearAgo) return today;
  return dateStr;
}

const uuid = () =>
  (crypto.randomUUID?.() || `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

function applyTheme() {
  const tp = tg?.themeParams || {};
  const root = document.documentElement;
  const map = {
    '--tg-bg': tp.bg_color || '#0f1419',
    '--tg-text': tp.text_color || '#e8eef7',
    '--tg-hint': tp.hint_color || '#8b9bb4',
    '--tg-button': tp.button_color || '#5b8def',
    '--tg-card': tp.secondary_bg_color || '#1a2332',
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
  document.body.classList.add('tg-theme');
  try {
    tg.setHeaderColor(map['--tg-bg']);
    tg.setBackgroundColor(map['--tg-bg']);
  } catch {}
}
applyTheme();
tg?.onEvent?.('themeChanged', applyTheme);

function getInitData() {
  // Всегда читаем актуальное значение — после ready() Telegram может заполнить initData чуть позже
  const fromTg = window.Telegram?.WebApp?.initData;
  if (fromTg && String(fromTg).length > 10) return String(fromTg);
  return 'dev';
}

async function api(path, options = {}) {
  const initData = getInitData();
  const res = await fetch('/api' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initData,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

async function waitForInitData(maxMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const d = getInitData();
    if (d && d !== 'dev' && d.includes('hash=')) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
  return getInitData();
}

function notify(message) {
  if (tg?.showAlert) tg.showAlert(String(message).slice(0, 300));
  else alert(message);
}

function confirmAsk(message) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(String(message).slice(0, 250), (ok) => resolve(Boolean(ok)));
    else resolve(window.confirm(message));
  });
}

function haptic(kind = 'success') {
  try { tg?.HapticFeedback?.notificationOccurred(kind); } catch {}
}

function busy(button, on, label) {
  if (!button) return;
  button.disabled = on;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || 'Подождите…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

const state = { type: 'expense', categories: [], accounts: [], settings: null, modal: null };

/* ---------- вкладки ---------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    try {
      if (btn.dataset.tab === 'ops') await loadAllTx();
      if (btn.dataset.tab === 'budget') await loadBudgets();
      if (btn.dataset.tab === 'piggy') await loadPiggies();
      if (btn.dataset.tab === 'more') { await loadAccounts(); await loadSettings(); }
    } catch (e) { notify(e.message); }
  });
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.type = chip.dataset.type;
    $('tx-submit').textContent = state.type === 'expense' ? 'Добавить расход' : 'Добавить доход';
    fillCategories();
  });
});

/* ---------- селекты ---------- */
const optionsHtml = (items, label) =>
  items.map((i) => `<option value="${Number(i.id)}">${esc(label(i))}</option>`).join('');

function fillCategories() {
  $('tx-category').innerHTML = optionsHtml(
    state.categories.filter((c) => c.type === state.type),
    (c) => `${c.icon || ''} ${c.name}`
  );
}
function fillBudgetCategories() {
  $('budget-category').innerHTML = optionsHtml(
    state.categories.filter((c) => c.type === 'expense'),
    (c) => `${c.icon || ''} ${c.name}`
  );
}
function fillAccounts() {
  $('tx-account').innerHTML = optionsHtml(state.accounts, (a) => `${a.icon || ''} ${a.name}`);
  const opts = optionsHtml(state.accounts, (a) => `${a.icon || ''} ${a.name} (${fmt(a.balance)})`);
  $('tr-from').innerHTML = opts;
  $('tr-to').innerHTML = opts;
  if (state.accounts.length > 1) $('tr-to').selectedIndex = 1;
}

/* ---------- дашборд ---------- */
async function loadDashboard() {
  const d = await api('/dashboard');
  $('greet').textContent = d.name ? `Привет, ${d.name}` : 'Привет';
  $('balance').textContent = fmt(d.balance);
  $('monthIncome').textContent = '+' + fmt(d.month.income);
  $('monthExpense').textContent = '−' + fmt(d.month.expense);

  state.accounts = d.accounts || [];
  fillAccounts();

  $('accounts-mini').innerHTML = state.accounts
    .map((a) => `<span>${esc(a.icon || '')} ${esc(a.name)}: ${fmt(a.balance)}</span>`)
    .join('');

  const cats = d.byCategory || [];
  const max = Math.max(...cats.map((c) => c.total), 1);
  $('categories-chart').innerHTML = cats.length
    ? cats.map((c) => `
        <div class="cat-row">
          <div class="cat-icon" style="background:${color(c.color)}33">${esc(c.icon || '💰')}</div>
          <div class="cat-info">
            <div class="cat-name">${esc(c.name || 'Без категории')}</div>
            <div class="cat-bar-wrap">
              <div class="cat-bar" style="width:${((c.total / max) * 100).toFixed(1)}%;background:${color(c.color)}"></div>
            </div>
          </div>
          <div class="cat-sum">${fmt(c.total)}</div>
        </div>`).join('')
    : '<div class="empty">Пока нет расходов в этом месяце</div>';

  renderTxList($('recent-list'), d.recent, false);
  renderMonths(await api('/stats/months?months=6'));
}

function renderMonths(data) {
  const max = Math.max(...data.flatMap((m) => [m.income, m.expense]), 1);
  $('months-chart').innerHTML = data
    .map((m) => `
      <div class="month-col">
        <div class="month-bars">
          <div class="month-bar inc" style="height:${Math.round((m.income / max) * 90)}px"></div>
          <div class="month-bar exp" style="height:${Math.round((m.expense / max) * 90)}px"></div>
        </div>
        <div class="month-label">${esc(m.label.slice(0, 2))}</div>
      </div>`)
    .join('');
}

/* ---------- список операций ---------- */
function renderTxList(el, rows, canDelete = true) {
  if (!rows?.length) {
    el.innerHTML = '<div class="empty">Пусто</div>';
    return;
  }
  el.innerHTML = rows
    .map((t) => {
      const sign = t.type === 'income' ? '+' : '−';
      const isTransfer = t.kind === 'transfer';
      const meta = [t.date, t.account_name ? `${t.account_icon || ''} ${t.account_name}` : '', isTransfer ? 'перевод' : '']
        .filter(Boolean)
        .join(' · ');
      const del = canDelete
        ? `<div class="tx-swipe-actions"><button type="button" data-del="${Number(t.id)}" data-transfer="${esc(t.transfer_id || '')}">Удалить</button></div>`
        : '';
      return `
      <div class="tx-swipe-wrap">
        ${del}
        <div class="tx-row">
          <div class="tx-icon" style="background:${color(t.category_color)}33">${esc(t.category_icon || (isTransfer ? '🔁' : '💰'))}</div>
          <div class="tx-info">
            <div class="tx-title">${esc(t.category_name || t.note || 'Операция')}</div>
            <div class="tx-meta">${esc(meta)}${t.note && t.category_name ? ' · ' + esc(t.note) : ''}</div>
          </div>
          <div class="tx-amount ${t.type === 'income' ? 'income' : 'expense'}">${sign}${fmt(t.amount)}</div>
        </div>
      </div>`;
    })
    .join('');

  if (canDelete) el.querySelectorAll('.tx-swipe-wrap').forEach(bindSwipe);
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const transferId = btn.dataset.transfer;
      const question = transferId ? 'Удалить перевод целиком?' : 'Удалить операцию?';
      if (!(await confirmAsk(question))) return;
      try {
        if (transferId) await api('/transfers/' + encodeURIComponent(transferId), { method: 'DELETE' });
        else await api('/transactions/' + Number(btn.dataset.del), { method: 'DELETE' });
        haptic('success');
        await Promise.all([loadDashboard(), loadAllTx()]);
      } catch (e) { notify(e.message); }
    });
  });
}

const swipeCleanups = [];
function bindSwipe(wrap) {
  const row = wrap.querySelector('.tx-row');
  let startX = 0, dx = 0, tracking = false;

  const start = (x) => { tracking = true; startX = x; dx = 0; row.style.transition = 'none'; };
  const move = (x) => {
    if (!tracking) return;
    dx = Math.min(0, Math.max(-88, x - startX));
    row.style.transform = `translateX(${dx}px)`;
  };
  const end = () => {
    if (!tracking) return;
    tracking = false;
    row.style.transition = 'transform 0.15s ease';
    const open = dx < -40;
    wrap.classList.toggle('open', open);
    row.style.transform = open ? 'translateX(-88px)' : '';
  };

  row.addEventListener('touchstart', (e) => start(e.touches[0].clientX), { passive: true });
  row.addEventListener('touchmove', (e) => move(e.touches[0].clientX), { passive: true });
  row.addEventListener('touchend', end);
  row.addEventListener('mousedown', (e) => start(e.clientX));
  row.addEventListener('mousemove', (e) => { if (e.buttons === 1) move(e.clientX); });
  window.addEventListener('mouseup', end);
  swipeCleanups.push(() => window.removeEventListener('mouseup', end));
}
function clearSwipes() {
  while (swipeCleanups.length) swipeCleanups.pop()();
}

/* ---------- загрузки ---------- */
async function loadCategories() {
  state.categories = await api('/categories');
  fillCategories();
  fillBudgetCategories();
}

async function loadAllTx() {
  clearSwipes();
  renderTxList($('all-tx'), await api('/transactions?limit=50'), true);
}

async function loadAccounts() {
  state.accounts = await api('/accounts');
  fillAccounts();
  $('accounts-list').innerHTML = state.accounts
    .map((a) => `
      <div class="cat-row">
        <div class="cat-icon">${esc(a.icon || '💳')}</div>
        <div class="cat-info">
          <div class="cat-name">${esc(a.name)}</div>
          <div class="tx-meta">${a.type === 'cash' ? 'Наличные' : a.type === 'card' ? 'Карта' : 'Другое'}</div>
        </div>
        <div class="cat-sum">${fmt(a.balance)}</div>
      </div>`)
    .join('');
}

async function loadBudgets() {
  const rows = await api('/budgets');
  $('budget-list').innerHTML = rows.length
    ? rows.map((b) => {
        const over = b.spent > b.amount;
        const c = over ? '#ff6b7a' : color(b.color);
        const pct = b.amount > 0 ? Math.min(100, (b.spent / b.amount) * 100) : 0;
        return `
        <div class="cat-row budget-row">
          <div class="budget-top">
            <div class="cat-icon" style="background:${c}33">${esc(b.icon || '💰')}</div>
            <div class="cat-info">
              <div class="cat-name">${esc(b.name)}</div>
              <div class="budget-meta ${over ? 'over' : ''}">${fmt(b.spent)} из ${fmt(b.amount)}${over ? ' — превышен!' : ''}</div>
              <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct.toFixed(1)}%;background:${c}"></div></div>
            </div>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty">Задайте лимит по категории ниже</div>';
}

async function loadPiggies() {
  const list = await api('/piggies');
  const el = $('piggy-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Создайте первую копилку</div>';
    return;
  }
  el.innerHTML = list
    .map((p) => {
      const pct = p.goal > 0 ? Math.min(100, (p.balance / p.goal) * 100) : 0;
      return `
      <div class="piggy-card">
        <div class="piggy-head">
          <div class="icon">${esc(p.icon || '🏦')}</div>
          <div>
            <div class="name">${esc(p.name)}</div>
            <div class="goal">Цель: ${fmt(p.goal)}</div>
          </div>
        </div>
        <div class="piggy-progress"><div style="width:${pct.toFixed(1)}%"></div></div>
        <div class="piggy-foot">
          <div class="piggy-bal">${fmt(p.balance)}</div>
          <div class="piggy-actions">
            <button data-act="deposit" data-id="${Number(p.id)}">+ Внести</button>
            <button data-act="withdraw" data-id="${Number(p.id)}">Снять</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
  el.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => openModal(btn.dataset.act, btn.dataset.id));
  });
}

async function loadSettings() {
  const s = await api('/settings');
  state.settings = s;
  $('remind-enabled').checked = Boolean(s.remind_enabled);
  const sel = $('remind-hour');
  if (!sel.options.length) {
    sel.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
  }
  sel.value = String(s.remind_hour ?? 21);

  const tzSel = $('tz-select');
  if (tzSel) {
    const tz = s.timezone || 'Europe/Moscow';
    // если пояса нет в списке — добавим
    if (![...tzSel.options].some((o) => o.value === tz)) {
      const opt = document.createElement('option');
      opt.value = tz;
      opt.textContent = tz;
      tzSel.appendChild(opt);
    }
    tzSel.value = tz;
  }
  $('tz-hint').textContent = `Сейчас: ${s.timezone || 'Europe/Moscow'}. Напоминания и «сегодня» считаются по этому поясу.`;
  $('admin-block').classList.toggle('hidden', !s.is_admin);
}

/* ---------- формы ---------- */
$('tx-date').value = todayLocal();

$('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('tx-submit');
  busy(btn, true, 'Сохраняю…');
  try {
    await api('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        amount: $('tx-amount').value,
        type: state.type,
        category_id: $('tx-category').value || null,
        account_id: $('tx-account').value || null,
        date: $('tx-date').value,
        note: $('tx-note').value,
        idempotency_key: uuid(),
      }),
    });
    haptic('success');
    $('tx-amount').value = '';
    $('tx-note').value = '';
    await Promise.all([loadDashboard(), loadAllTx()]);
  } catch (err) {
    notify(err.message);
  } finally {
    busy(btn, false);
  }
});

$('transfer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  busy(btn, true, 'Перевожу…');
  try {
    await api('/transfers', {
      method: 'POST',
      body: JSON.stringify({
        from_id: $('tr-from').value,
        to_id: $('tr-to').value,
        amount: $('tr-amount').value,
        date: todayLocal(),
      }),
    });
    haptic('success');
    $('tr-amount').value = '';
    await Promise.all([loadDashboard(), loadAccounts()]);
  } catch (err) {
    notify(err.message);
  } finally {
    busy(btn, false);
  }
});

$('budget-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/budgets', {
      method: 'POST',
      body: JSON.stringify({ category_id: $('budget-category').value, amount: $('budget-amount').value }),
    });
    $('budget-amount').value = '';
    await loadBudgets();
  } catch (err) { notify(err.message); }
});

$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: $('acc-name').value, type: $('acc-type').value }),
    });
    $('acc-name').value = '';
    await Promise.all([loadAccounts(), loadDashboard()]);
  } catch (err) { notify(err.message); }
});

$('btn-new-piggy').addEventListener('click', () => $('piggy-form').classList.toggle('hidden'));

$('piggy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/piggies', {
      method: 'POST',
      body: JSON.stringify({ name: $('piggy-name').value, goal: $('piggy-goal').value || 0 }),
    });
    $('piggy-name').value = '';
    $('piggy-goal').value = '';
    $('piggy-form').classList.add('hidden');
    await loadPiggies();
  } catch (err) { notify(err.message); }
});

/* ---------- модалка копилок ---------- */
function openModal(act, id) {
  state.modal = { act, id };
  $('modal-title').textContent = act === 'deposit' ? 'Пополнить копилку' : 'Снять с копилки';
  $('modal-amount').value = '';
  $('modal').classList.remove('hidden');
}
$('modal-cancel').addEventListener('click', () => {
  $('modal').classList.add('hidden');
  state.modal = null;
});
$('modal-ok').addEventListener('click', async () => {
  if (!state.modal) return;
  const { act, id } = state.modal;
  try {
    await api(`/piggies/${Number(id)}/${act === 'withdraw' ? 'withdraw' : 'deposit'}`, {
      method: 'POST',
      body: JSON.stringify({ amount: $('modal-amount').value }),
    });
    haptic('success');
    $('modal').classList.add('hidden');
    state.modal = null;
    await loadPiggies();
  } catch (err) { notify(err.message); }
});

/* ---------- распознавание ---------- */
const setStatus = (msg) => { $('sms-status').textContent = msg || ''; };


/* ---------- проверка чека с правкой категории ---------- */
const reviewQueue = [];
let reviewIndex = 0;

function fillReviewCategoryOptions(selectedName, selectedId) {
  const sel = $('review-category');
  const cats = (state.categories || []).filter((c) => c.type === 'expense' || !c.type);
  sel.innerHTML = cats.map((c) => {
    const selAttr = (selectedId && Number(c.id) === Number(selectedId))
      || (selectedName && c.name === selectedName) ? ' selected' : '';
    return `<option value="${c.id}"${selAttr}>${esc(c.name)}</option>`;
  }).join('');
  if (!sel.options.length) {
    sel.innerHTML = '<option value="">Прочее</option>';
  }
}

function showReviewItem() {
  if (reviewIndex >= reviewQueue.length) {
    $('review-modal').classList.add('hidden');
    notify(`Сохранено чеков: обработано ${reviewQueue.length}`);
    Promise.all([loadDashboard(), loadAllTx()]).catch(() => {});
    return;
  }
  const d = reviewQueue[reviewIndex];
  $('review-title').textContent = `Чек ${reviewIndex + 1} из ${reviewQueue.length}`;
  $('review-hint').textContent = d._label ? `Файл: ${d._label}` : (d.source || '');
  $('review-amount').value = d.amount ?? '';
  $('review-note').value = d.note || '';
  $('review-date').value = clampReceiptDate(d.date);
  fillReviewCategoryOptions(d.category_name, d.category_id);
  $('review-modal').classList.remove('hidden');
}

async function saveReviewCurrent() {
  const d = reviewQueue[reviewIndex];
  const amount = $('review-amount').value;
  const category_id = $('review-category').value || null;
  const note = $('review-note').value;
  const date = clampReceiptDate($('review-date').value);
  await api('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      amount,
      type: 'expense',
      category_id: category_id || null,
      account_id: $('tx-account')?.value || null,
      date,
      note,
      idempotency_key: uuid(),
    }),
  });
  haptic('success');
  reviewIndex += 1;
  showReviewItem();
}

function skipReviewCurrent() {
  reviewIndex += 1;
  showReviewItem();
}

async function saveAllReviewRemaining() {
  const btn = $('review-save-all');
  busy(btn, true, 'Сохраняю…');
  try {
    while (reviewIndex < reviewQueue.length) {
      // подставляем текущие поля только для первого, остальные — как распознаны
      if (reviewIndex === reviewQueue.findIndex((_, i) => i >= reviewIndex)) {
        // always use form for current, defaults for rest after first save uses form once
      }
      const d = reviewQueue[reviewIndex];
      const isCurrent = true;
      const amount = isCurrent ? $('review-amount').value : d.amount;
      const category_id = isCurrent ? ($('review-category').value || d.category_id) : (d.category_id || null);
      const note = isCurrent ? $('review-note').value : (d.note || '');
      const date = isCurrent ? ($('review-date').value || todayLocal()) : (d.date || todayLocal());
      await api('/transactions', {
        method: 'POST',
        body: JSON.stringify({
          amount: amount || d.amount,
          type: 'expense',
          category_id,
          account_id: $('tx-account')?.value || null,
          date,
          note,
          idempotency_key: uuid(),
        }),
      });
      reviewIndex += 1;
      if (reviewIndex < reviewQueue.length) {
        // обновить форму для следующего перед сохранением «как есть»
        const n = reviewQueue[reviewIndex];
        $('review-amount').value = n.amount ?? '';
        $('review-note').value = n.note || '';
        $('review-date').value = n.date || todayLocal();
        fillReviewCategoryOptions(n.category_name, n.category_id);
      }
    }
    haptic('success');
    $('review-modal').classList.add('hidden');
    await Promise.all([loadDashboard(), loadAllTx()]);
    notify('Все чеки сохранены отдельными операциями');
  } catch (e) {
    notify(e.message);
  } finally {
    busy(btn, false);
  }
}

async function confirmAndSave(draft) {
  return openReviewQueue([draft]);
}

async function openReviewQueue(drafts) {
  try {
    if (!state.categories?.length) await loadCategories();
  } catch {}
  reviewQueue.length = 0;
  for (const d of drafts) {
    if (d && d.amount) {
      reviewQueue.push({
        ...d,
        date: clampReceiptDate(d.date),
        type: d.type || 'expense',
      });
    }
  }
  if (!reviewQueue.length) {
    notify('Нечего сохранять');
    return;
  }
  reviewIndex = 0;
  showReviewItem();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.readAsDataURL(file);
  });
}


$('btn-parse-sms').addEventListener('click', async (e) => {
  const text = $('sms-text').value.trim();
  if (!text) return setStatus('Вставьте текст SMS');
  busy(e.currentTarget, true, 'Распознаю…');
  setStatus('Распознаю SMS…');
  try {
    await confirmAndSave(await api('/parse-sms', { method: 'POST', body: JSON.stringify({ text }) }));
    $('sms-text').value = '';
  } catch (err) {
    setStatus(err.message);
  } finally {
    busy(e.currentTarget, false);
  }
});

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });


$('receipt-file').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;

  const status = $('sms-status');
  const drafts = [];
  status.textContent = `Распознаю 0/${files.length}…`;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    status.textContent = `Распознаю ${i + 1}/${files.length}: ${file.name}…`;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const isImage = String(file.type).startsWith('image/') || dataUrl.startsWith('data:image');
      const body = isPdf ? { pdfBase64: dataUrl, multi: true } : { image: dataUrl };
      const res = await api('/parse-receipt', { method: 'POST', body: JSON.stringify(body) });
      // backend may return {items:[...]} or single draft
      const items = Array.isArray(res.items) ? res.items : [res];
      for (const it of items) {
        if (it && it.amount) drafts.push({ ...it, _label: file.name });
      }
    } catch (err) {
      console.warn(file.name, err);
      status.textContent = `${file.name}: ${err.message}`;
    }
  }

  if (!drafts.length) {
    status.textContent = 'Не удалось распознать файлы';
    notify('Не удалось распознать чеки');
    return;
  }
  status.textContent = `Распознано чеков: ${drafts.length}. Проверьте и сохраните.`;
  await openReviewQueue(drafts);
});

$('review-save')?.addEventListener('click', async () => {
  try {
    await saveReviewCurrent();
  } catch (e) {
    notify(e.message);
  }
});
$('review-skip')?.addEventListener('click', () => skipReviewCurrent());
$('review-save-all')?.addEventListener('click', () => saveAllReviewRemaining());

$('tz-select')?.addEventListener('change', async (e) => {
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify({ timezone: e.target.value }) });
    $('tz-hint').textContent = `Сейчас: ${e.target.value}. Напоминания и «сегодня» по этому поясу.`;
    haptic('success');
  } catch (err) {
    notify(err.message);
  }
});


/* ---------- настройки и бэкап ---------- */
$('remind-enabled').addEventListener('change', async (e) => {
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify({ remind_enabled: e.target.checked }) });
  } catch (err) { notify(err.message); }
});

$('remind-hour').addEventListener('change', async (e) => {
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({ remind_hour: Number(e.target.value), remind_enabled: true }),
    });
    $('remind-enabled').checked = true;
  } catch (err) { notify(err.message); }
});

$('btn-backup').addEventListener('click', async (e) => {
  busy(e.currentTarget, true, 'Делаю бэкап…');
  try {
    const r = await api('/backup', { method: 'POST' });
    $('backup-status').textContent = r.ok ? `Бэкап создан: ${r.file}` : `Ошибка: ${r.error}`;
    haptic(r.ok ? 'success' : 'error');
  } catch (err) {
    notify(err.message);
  } finally {
    busy(e.currentTarget, false);
  }
});

/* ---------- старт ---------- */
(async () => {
  try {
    if (window.Telegram?.WebApp) {
      try { window.Telegram.WebApp.ready(); } catch {}
      try { window.Telegram.WebApp.expand(); } catch {}
    }
    const id = await waitForInitData(3000);
    if (!id || id === 'dev' || !id.includes('hash=')) {
      $('balance').textContent = '—';
      $('recent-list').innerHTML =
        `<div class="empty">Нет данных Telegram.<br>` +
        `<b>Откройте приложение кнопкой в боте</b> ( /start → «Открыть бюджет» ), ` +
        `а не по прямой ссылке в браузере.</div>`;
      return;
    }
    await loadCategories();
    await loadDashboard();
    await loadSettings();
  } catch (e) {
    $('balance').textContent = '—';
    $('recent-list').innerHTML = `<div class="empty">Не удалось загрузить данные.<br><b>${esc(e.message)}</b></div>`;
  }
})();
