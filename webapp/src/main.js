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

const initData = tg?.initData || 'dev';

async function api(path, options = {}) {
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
  $('tz-hint').textContent = `Бот пришлёт сводку за день по вашему времени (${s.timezone}). Также работает /remind on в чате.`;
  $('admin-block').classList.toggle('hidden', !s.is_admin);

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (browserTz && browserTz !== s.timezone) {
    try {
      await api('/settings', { method: 'POST', body: JSON.stringify({ timezone: browserTz }) });
    } catch {}
  }
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

async function confirmAndSave(draft) {
  const sign = draft.type === 'income' ? '+' : '−';
  const ok = await confirmAsk(
    `Записать?\n${sign}${fmt(draft.amount)} · ${draft.type === 'income' ? 'доход' : 'расход'}\n` +
      `${draft.category_name || '—'}\n${draft.note || ''}`
  );
  if (!ok) return setStatus('Отменено');

  await api('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      amount: draft.amount,
      type: draft.type,
      category_id: draft.category_id,
      account_id: state.accounts[0]?.id ?? null,
      note: draft.note || '',
      date: draft.date || todayLocal(),
      idempotency_key: uuid(),
    }),
  });
  setStatus('Записано ✓');
  haptic('success');
  await loadDashboard();
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
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  setStatus(`Читаю ${file.name}…`);
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Файл больше 5 МБ — сожмите или сделайте фото');
    const dataUrl = await readAsDataUrl(file);
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImage = file.type.startsWith('image/') || String(dataUrl).startsWith('data:image');
    if (!isPdf && !isImage) throw new Error('Нужны JPG, PNG или PDF');
    const body = isImage ? { image: dataUrl } : { pdfBase64: dataUrl };
    await confirmAndSave(await api('/parse-receipt', { method: 'POST', body: JSON.stringify(body) }));
  } catch (err) {
    setStatus(err.message);
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
    await loadCategories();
    await loadDashboard();
    await loadSettings();
  } catch (e) {
    $('balance').textContent = '—';
    $('recent-list').innerHTML = `<div class="empty">Не удалось загрузить данные.<br><b>${esc(e.message)}</b></div>`;
  }
})();
