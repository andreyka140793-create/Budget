const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.disableVerticalSwipes?.(); } catch {}
  try {
    // Полноэкранный режим (Telegram 8+)
    if (typeof tg.requestFullscreen === 'function') tg.requestFullscreen();
  } catch {}
  try { tg.setHeaderColor('secondary_bg_color'); } catch {}
  try { tg.setBackgroundColor('bg_color'); } catch {}
}

// ----- Theme from Telegram -----
function applyTheme() {
  const tp = tg?.themeParams || {};
  const root = document.documentElement;
  const bg = tp.bg_color || '#0f1419';
  const text = tp.text_color || '#e8eef7';
  const hint = tp.hint_color || '#8b9bb4';
  const button = tp.button_color || '#5b8def';
  const secondary = tp.secondary_bg_color || '#1a2332';

  root.style.setProperty('--tg-bg', bg);
  root.style.setProperty('--tg-text', text);
  root.style.setProperty('--tg-hint', hint);
  root.style.setProperty('--tg-button', button);
  root.style.setProperty('--tg-card', secondary);
  document.body.classList.add('tg-theme');
  document.body.style.background = bg;
  document.body.style.color = text;

  try {
    tg.setHeaderColor(bg);
    tg.setBackgroundColor(bg);
  } catch {}
}
applyTheme();
tg?.onEvent?.('themeChanged', applyTheme);

const initData = tg?.initData || 'dev';
const API = '/api';

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initData,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const fmt = (n) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n || 0) + ' ₽';

let state = { type: 'expense', categories: [], accounts: [], modal: null };

// Tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'ops') loadAllTx();
    if (btn.dataset.tab === 'budget') loadBudgets();
    if (btn.dataset.tab === 'piggy') loadPiggies();
    if (btn.dataset.tab === 'more') {
      loadAccounts();
      loadSettings();
      fillTransferSelects();
    }
  });
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.type = chip.dataset.type;
    document.getElementById('tx-submit').textContent =
      state.type === 'expense' ? 'Добавить расход' : 'Добавить доход';
    fillCategories();
  });
});

function fillCategories() {
  const sel = document.getElementById('tx-category');
  const list = state.categories.filter((c) => c.type === state.type);
  sel.innerHTML = list.map((c) => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
}

function fillAccounts() {
  const sel = document.getElementById('tx-account');
  sel.innerHTML = state.accounts
    .map((a) => `<option value="${a.id}">${a.icon || ''} ${a.name}</option>`)
    .join('');
}

function fillTransferSelects() {
  const opts = state.accounts
    .map((a) => `<option value="${a.id}">${a.icon || ''} ${a.name} (${fmt(a.balance)})</option>`)
    .join('');
  document.getElementById('tr-from').innerHTML = opts;
  document.getElementById('tr-to').innerHTML = opts;
  if (state.accounts.length > 1) {
    document.getElementById('tr-to').selectedIndex = 1;
  }
}

function fillBudgetCategories() {
  const sel = document.getElementById('budget-category');
  const list = state.categories.filter((c) => c.type === 'expense');
  sel.innerHTML = list.map((c) => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
}

async function loadDashboard() {
  const d = await api('/dashboard');
  document.getElementById('greet').textContent = d.name ? `Привет, ${d.name}` : 'Привет';
  document.getElementById('balance').textContent = fmt(d.balance);
  document.getElementById('monthIncome').textContent = '+' + fmt(d.month.income);
  document.getElementById('monthExpense').textContent = '−' + fmt(d.month.expense);

  state.accounts = d.accounts || [];
  fillAccounts();
  fillTransferSelects();

  document.getElementById('accounts-mini').innerHTML = (d.accounts || [])
    .map((a) => `<span>${a.icon || ''} ${a.name}: ${fmt(a.balance)}</span>`)
    .join('');

  const max = Math.max(...(d.byCategory || []).map((c) => c.total), 1);
  const chart = document.getElementById('categories-chart');
  if (!d.byCategory?.length) {
    chart.innerHTML = '<div class="empty">Пока нет расходов в этом месяце</div>';
  } else {
    chart.innerHTML = d.byCategory
      .map(
        (c) => `
      <div class="cat-row">
        <div class="cat-icon" style="background:${c.color}33">${c.icon || '💰'}</div>
        <div class="cat-info">
          <div class="cat-name">${c.name || 'Без категории'}</div>
          <div class="cat-bar-wrap"><div class="cat-bar" style="width:${(c.total / max) * 100}%;background:${c.color || '#5b8def'}"></div></div>
        </div>
        <div class="cat-sum">${fmt(c.total)}</div>
      </div>`
      )
      .join('');
  }

  renderTxList(document.getElementById('recent-list'), d.recent, false);
  await loadMonthsChart();
}

async function loadMonthsChart() {
  const data = await api('/stats/months?months=6');
  const max = Math.max(...data.flatMap((m) => [m.income, m.expense]), 1);
  document.getElementById('months-chart').innerHTML = data
    .map((m) => {
      const ih = Math.round((m.income / max) * 90);
      const eh = Math.round((m.expense / max) * 90);
      return `
      <div class="month-col">
        <div class="month-bars">
          <div class="month-bar inc" style="height:${ih}px"></div>
          <div class="month-bar exp" style="height:${eh}px"></div>
        </div>
        <div class="month-label">${m.label.slice(0, 2)}</div>
      </div>`;
    })
    .join('');
}

// ----- Swipe to delete -----
function bindSwipe(wrap) {
  const row = wrap.querySelector('.tx-row');
  let startX = 0;
  let dx = 0;
  let tracking = false;

  const onStart = (x) => {
    tracking = true;
    startX = x;
    dx = 0;
    row.style.transition = 'none';
  };
  const onMove = (x) => {
    if (!tracking) return;
    dx = Math.min(0, Math.max(-88, x - startX));
    row.style.transform = `translateX(${dx}px)`;
  };
  const onEnd = () => {
    if (!tracking) return;
    tracking = false;
    row.style.transition = 'transform 0.15s ease';
    if (dx < -40) {
      wrap.classList.add('open');
      row.style.transform = 'translateX(-88px)';
    } else {
      wrap.classList.remove('open');
      row.style.transform = '';
    }
  };

  row.addEventListener('touchstart', (e) => onStart(e.touches[0].clientX), { passive: true });
  row.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX), { passive: true });
  row.addEventListener('touchend', onEnd);
  row.addEventListener('mousedown', (e) => onStart(e.clientX));
  window.addEventListener('mouseup', onEnd);
  row.addEventListener('mousemove', (e) => {
    if (e.buttons === 1) onMove(e.clientX);
  });
}

function renderTxList(el, rows, canDelete = true) {
  if (!rows?.length) {
    el.innerHTML = '<div class="empty">Пусто</div>';
    return;
  }
  el.innerHTML = rows
    .map((t) => {
      const sign = t.type === 'income' ? '+' : '−';
      const cls = t.type === 'income' ? 'income' : 'expense';
      const acc = t.account_name ? ` · ${t.account_icon || ''} ${t.account_name}` : '';
      const delBtn = canDelete
        ? `<div class="tx-swipe-actions"><button type="button" data-del="${t.id}">Удалить</button></div>`
        : '';
      return `
      <div class="tx-swipe-wrap" data-id="${t.id}">
        ${delBtn}
        <div class="tx-row">
          <div class="tx-icon" style="background:${(t.category_color || '#5b8def')}33">${t.category_icon || '💰'}</div>
          <div class="tx-info">
            <div class="tx-title">${t.category_name || t.note || 'Операция'}</div>
            <div class="tx-meta">${t.date}${acc}${t.note && t.category_name ? ' · ' + t.note : ''}</div>
          </div>
          <div class="tx-amount ${cls}">${sign}${fmt(t.amount)}</div>
        </div>
      </div>`;
    })
    .join('');

  el.querySelectorAll('.tx-swipe-wrap').forEach((w) => {
    if (canDelete) bindSwipe(w);
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить операцию?')) return;
      try {
        await api('/transactions/' + btn.dataset.del, { method: 'DELETE' });
        if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadDashboard();
        await loadAllTx();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

async function loadCategories() {
  state.categories = await api('/categories');
  fillCategories();
  fillBudgetCategories();
}

async function loadAllTx() {
  const rows = await api('/transactions?limit=50');
  renderTxList(document.getElementById('all-tx'), rows, true);
}

document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);

document.getElementById('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('tx-amount').value);
  const category_id = parseInt(document.getElementById('tx-category').value, 10);
  const account_id = parseInt(document.getElementById('tx-account').value, 10);
  const date = document.getElementById('tx-date').value;
  const note = document.getElementById('tx-note').value;
  try {
    await api('/transactions', {
      method: 'POST',
      body: JSON.stringify({ amount, type: state.type, category_id, account_id, date, note }),
    });
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    document.getElementById('tx-amount').value = '';
    document.getElementById('tx-note').value = '';
    await loadDashboard();
    await loadAllTx();
  } catch (err) {
    alert(err.message);
  }
});

// Transfer
document.getElementById('transfer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from_id = parseInt(document.getElementById('tr-from').value, 10);
  const to_id = parseInt(document.getElementById('tr-to').value, 10);
  const amount = parseFloat(document.getElementById('tr-amount').value);
  try {
    await api('/accounts/transfer', {
      method: 'POST',
      body: JSON.stringify({ from_id, to_id, amount }),
    });
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    document.getElementById('tr-amount').value = '';
    await loadDashboard();
    await loadAccounts();
    fillTransferSelects();
  } catch (err) {
    alert(err.message);
  }
});

// Budgets
async function loadBudgets() {
  const rows = await api('/budgets');
  const el = document.getElementById('budget-list');
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Задай лимит по категории ниже</div>';
    return;
  }
  el.innerHTML = rows
    .map((b) => {
      const pct = b.amount > 0 ? Math.min(100, (b.spent / b.amount) * 100) : 0;
      const over = b.spent > b.amount;
      const color = over ? '#ff6b7a' : b.color || '#5b8def';
      return `
      <div class="cat-row budget-row">
        <div class="budget-top">
          <div class="cat-icon" style="background:${color}33">${b.icon || '💰'}</div>
          <div class="cat-info">
            <div class="cat-name">${b.name}</div>
            <div class="budget-meta ${over ? 'over' : ''}">
              ${fmt(b.spent)} из ${fmt(b.amount)}${over ? ' — превышен!' : ''}
            </div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${color}"></div></div>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

document.getElementById('budget-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const category_id = parseInt(document.getElementById('budget-category').value, 10);
  const amount = parseFloat(document.getElementById('budget-amount').value);
  await api('/budgets', { method: 'POST', body: JSON.stringify({ category_id, amount }) });
  document.getElementById('budget-amount').value = '';
  loadBudgets();
});

// Accounts
async function loadAccounts() {
  state.accounts = await api('/accounts');
  fillAccounts();
  fillTransferSelects();
  document.getElementById('accounts-list').innerHTML = state.accounts
    .map(
      (a) => `
    <div class="cat-row">
      <div class="cat-icon">${a.icon || '💳'}</div>
      <div class="cat-info">
        <div class="cat-name">${a.name}</div>
        <div class="tx-meta">${a.type === 'cash' ? 'Наличные' : a.type === 'card' ? 'Карта' : 'Другое'}</div>
      </div>
      <div class="cat-sum">${fmt(a.balance)}</div>
    </div>`
    )
    .join('');
}

document.getElementById('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('acc-name').value.trim();
  const type = document.getElementById('acc-type').value;
  await api('/accounts', { method: 'POST', body: JSON.stringify({ name, type }) });
  document.getElementById('acc-name').value = '';
  loadAccounts();
  loadDashboard();
});

// Backup





function setStatus(msg) {
  const el = document.getElementById('sms-status');
  if (el) el.textContent = msg || '';
}

async function confirmAndSaveParsed(r, fallbackNote) {
  const sign = r.type === 'income' ? '+' : '−';
  const title = 'Записать операцию?';
  const message =
    `${sign}${fmt(r.amount)} · ${r.type === 'income' ? 'доход' : 'расход'}\n` +
    `${r.category_name || '—'}\n${r.note || r.merchant || fallbackNote || ''}`;

  let ok = false;
  if (tg?.showPopup) {
    ok = await new Promise((resolve) => {
      tg.showPopup(
        {
          title,
          message: message.slice(0, 250),
          buttons: [
            { id: 'yes', type: 'default', text: 'Записать' },
            { id: 'no', type: 'cancel', text: 'Отмена' },
          ],
        },
        (id) => resolve(id === 'yes')
      );
    });
  } else {
    ok = confirm(`${title}\n\n${message}`);
  }
  if (!ok) {
    setStatus('Отменено');
    return;
  }

  const acc = state.accounts[0];
  await api('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      amount: r.amount,
      type: r.type,
      category_id: r.category_id,
      account_id: acc?.id,
      note: r.note || r.merchant || fallbackNote || '',
      date: r.date || new Date().toISOString().slice(0, 10),
    }),
  });
  setStatus('Записано ✓');
  if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  await loadDashboard();
}

document.getElementById('btn-parse-sms').addEventListener('click', async () => {
  const text = document.getElementById('sms-text').value.trim();
  if (!text) {
    setStatus('Вставьте текст SMS');
    return;
  }
  setStatus('Распознаю SMS…');
  try {
    const r = await api('/parse-sms', { method: 'POST', body: JSON.stringify({ text }) });
    await confirmAndSaveParsed(r, text.slice(0, 80));
    document.getElementById('sms-text').value = '';
  } catch (e) {
    setStatus(e.message);
    alert(e.message);
  }
});

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

const receiptInput = document.getElementById('receipt-file');
if (receiptInput) {
  receiptInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      setStatus('Файл не выбран');
      return;
    }
    const prev = document.getElementById('receipt-preview');
    if (prev) {
      prev.style.display = 'block';
      prev.textContent = `Файл: ${file.name} (${Math.round(file.size / 1024)} КБ)`;
    }
    setStatus('Распознаю чек…');
    try {
      if (file.size > 7 * 1024 * 1024) {
        throw new Error('Файл больше 7 МБ — сожмите или сделайте фото');
      }
      const dataUrl = await readFileAsDataURL(file);
      const isPdf =
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf') ||
        (typeof dataUrl === 'string' && dataUrl.startsWith('data:application/pdf'));
      const isImage =
        file.type.startsWith('image/') ||
        (typeof dataUrl === 'string' && dataUrl.startsWith('data:image'));

      let body;
      if (isImage) body = { image: dataUrl };
      else if (isPdf) body = { pdfBase64: dataUrl };
      else throw new Error('Нужны фото (JPG/PNG) или PDF');

      setStatus(isPdf ? 'Читаю PDF…' : 'Читаю фото…');
      const r = await api('/parse-receipt', { method: 'POST', body: JSON.stringify(body) });
      await confirmAndSaveParsed(r, file.name);
    } catch (err) {
      console.error(err);
      setStatus(err.message || String(err));
      alert(err.message || String(err));
    }
    e.target.value = '';
  });
}


document.getElementById('btn-backup').addEventListener('click', async () => {
  try {
    const r = await api('/backup', { method: 'POST' });
    document.getElementById('backup-status').textContent = r.ok
      ? `Бэкап создан: ${r.file}`
      : `Ошибка: ${r.error}`;
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  } catch (e) {
    alert(e.message);
  }
});

// Settings
async function loadSettings() {
  const s = await api('/settings');
  document.getElementById('remind-enabled').checked = !!s.remind_enabled;
  const sel = document.getElementById('remind-hour');
  if (!sel.options.length) {
    for (let h = 0; h < 24; h++) {
      const o = document.createElement('option');
      o.value = h;
      o.textContent = `${String(h).padStart(2, '0')}:00`;
      sel.appendChild(o);
    }
  }
  sel.value = s.remind_hour ?? 21;
}

document.getElementById('remind-enabled').addEventListener('change', async (e) => {
  await api('/settings', {
    method: 'POST',
    body: JSON.stringify({ remind_enabled: e.target.checked }),
  });
});

document.getElementById('remind-hour').addEventListener('change', async (e) => {
  await api('/settings', {
    method: 'POST',
    body: JSON.stringify({ remind_hour: parseInt(e.target.value, 10), remind_enabled: true }),
  });
  document.getElementById('remind-enabled').checked = true;
});

// Piggies
async function loadPiggies() {
  const list = await api('/piggies');
  const el = document.getElementById('piggy-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Создай первую копилку</div>';
    return;
  }
  el.innerHTML = list
    .map((p) => {
      const pct = p.goal > 0 ? Math.min(100, (p.balance / p.goal) * 100) : 0;
      return `
      <div class="piggy-card">
        <div class="piggy-head">
          <div class="icon">${p.icon || '🏦'}</div>
          <div>
            <div class="name">${p.name}</div>
            <div class="goal">Цель: ${fmt(p.goal)}</div>
          </div>
        </div>
        <div class="piggy-progress"><div style="width:${pct}%"></div></div>
        <div class="piggy-foot">
          <div class="piggy-bal">${fmt(p.balance)}</div>
          <div class="piggy-actions">
            <button data-act="deposit" data-id="${p.id}">+ Внести</button>
            <button data-act="withdraw" data-id="${p.id}">Снять</button>
          </div>
        </div>
      </div>`;
    })
    .join('');

  el.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => openModal(btn.dataset.act, btn.dataset.id));
  });
}

document.getElementById('btn-new-piggy').addEventListener('click', () => {
  document.getElementById('piggy-form').classList.toggle('hidden');
});

document.getElementById('piggy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('piggy-name').value.trim();
  const goal = parseFloat(document.getElementById('piggy-goal').value) || 0;
  await api('/piggies', { method: 'POST', body: JSON.stringify({ name, goal }) });
  document.getElementById('piggy-name').value = '';
  document.getElementById('piggy-goal').value = '';
  document.getElementById('piggy-form').classList.add('hidden');
  loadPiggies();
});

function openModal(act, id) {
  state.modal = { act, id };
  document.getElementById('modal-title').textContent =
    act === 'deposit' ? 'Пополнить копилку' : 'Снять с копилки';
  document.getElementById('modal-amount').value = '';
  document.getElementById('modal').classList.remove('hidden');
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal').classList.add('hidden');
  state.modal = null;
});

document.getElementById('modal-ok').addEventListener('click', async () => {
  if (!state.modal) return;
  const amount = parseFloat(document.getElementById('modal-amount').value);
  if (!amount || amount <= 0) return;
  const { act, id } = state.modal;
  try {
    await api(`/piggies/${id}/${act}`, { method: 'POST', body: JSON.stringify({ amount }) });
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    document.getElementById('modal').classList.add('hidden');
    state.modal = null;
    loadPiggies();
  } catch (err) {
    alert(err.message);
  }
});

(async () => {
  try {
    await loadCategories();
    await loadDashboard();
  } catch (e) {
    console.error(e);
    document.getElementById('balance').textContent = 'Ошибка';
    const msg = (e && e.message) ? e.message : String(e);
    document.getElementById('recent-list').innerHTML =
      `<div class="empty">Не удалось загрузить данные.<br><b>${msg}</b></div>`;
    const g = document.getElementById('greet');
    if (g) g.textContent = msg;
  }
})();
