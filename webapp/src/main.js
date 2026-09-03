const tg = window.Telegram?.WebApp || null;

// Telegram clients differ in which Mini App APIs they support.
// Never let an optional Telegram API failure prevent the rest of the UI from booting.
function initTelegram() {
  if (!tg) return;
  try { tg.ready?.(); } catch (e) { console.warn('Telegram ready failed', e); }
  try { tg.expand?.(); } catch (e) { console.warn('Telegram expand failed', e); }
  try { tg.disableVerticalSwipes?.(); } catch (e) { console.warn('disableVerticalSwipes failed', e); }

  const requestFs = () => {
    try { tg.expand?.(); } catch {}
    try {
      if (typeof tg.requestFullscreen === 'function' &&
          (!tg.isVersionAtLeast || tg.isVersionAtLeast('8.0'))) {
        tg.requestFullscreen();
      }
    } catch (e) {
      console.warn('Telegram fullscreen request failed', e);
    }
  };

  try { tg.onEvent?.('fullscreen_failed', e => {
    console.warn('Telegram fullscreen failed', e);
    try { tg.expand?.(); } catch {}
  }); } catch {}

  // Try after initialization, after activation/viewport changes, and on the
  // first real tap. This covers Telegram clients that reject an early request.
  setTimeout(requestFs, 250);
  setTimeout(requestFs, 1200);
  try { tg.onEvent?.('activated', requestFs); } catch {}
  try { tg.onEvent?.('viewportChanged', requestFs); } catch {}

  document.addEventListener('pointerdown', () => requestFs(), {once:true, passive:true});

  const fsButton = document.getElementById('btn-fullscreen');
  fsButton?.addEventListener('click', () => {
    requestFs();
    haptic('success');
  });
}

initTelegram();

const API='/api';
const initData=tg?.initData || '';

const state={type:'expense',categories:[],accounts:[],modal:null,busy:new Set()};

function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function localDate(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function fmt(n){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(n)||0)+' ₽';}
function moneyValue(n){return Number(n)||0;}
function haptic(kind='success'){try{tg?.HapticFeedback?.notificationOccurred(kind);}catch{}}

function applyTheme(){const tp=tg?.themeParams||{},r=document.documentElement;const values={bg:tp.bg_color||'#0f1419',text:tp.text_color||'#e8eef7',hint:tp.hint_color||'#8b9bb4',button:tp.button_color||'#5b8def',card:tp.secondary_bg_color||'#1a2332'};for(const[k,v]of Object.entries(values))r.style.setProperty(`--tg-${k}`,v);document.body.style.background=values.bg;document.body.style.color=values.text;}
applyTheme();tg?.onEvent?.('themeChanged',applyTheme);

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? {'Content-Type': 'application/json'} : {}),
    ...(initData ? {'X-Telegram-Init-Data': initData} : {}),
    ...(options.headers || {})
  };
  let res;
  try {
    res = await fetch(API + path, { ...options, headers, credentials: 'same-origin' });
  } catch {
    throw new Error('Нет соединения с сервером');
  }
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json().catch(() => ({}))
    : { error: await res.text().catch(() => '') };
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}
async function withBusy(key,fn){if(state.busy.has(key))return;state.busy.add(key);try{return await fn();}finally{state.busy.delete(key);}}

function setOptions(id,rows,mapper){const el=document.getElementById(id);el.innerHTML=rows.map(mapper).join('');}
function fillCategories(){const rows=state.categories.filter(c=>c.type===state.type);setOptions('tx-category',rows,c=>`<option value="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`);fillBudgetCategories();}
function fillBudgetCategories(){const rows=state.categories.filter(c=>c.type==='expense');setOptions('budget-category',rows,c=>`<option value="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`);}
function fillAccounts(){setOptions('tx-account',state.accounts,a=>`<option value="${a.id}">${escapeHtml(a.icon)} ${escapeHtml(a.name)}</option>`);fillTransferSelects();}
function fillTransferSelects(){const opts=state.accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.icon||'')} ${escapeHtml(a.name)} (${fmt(a.balance)})</option>`).join('');document.getElementById('tr-from').innerHTML=opts;document.getElementById('tr-to').innerHTML=opts;if(state.accounts.length>1)document.getElementById('tr-to').selectedIndex=1;}

async function loadCategories(){state.categories=await api('/categories');fillCategories();}
async function loadAccounts(){state.accounts=await api('/accounts');fillAccounts();const el=document.getElementById('accounts-list');el.innerHTML=state.accounts.map(a=>`<div class="cat-row"><div class="cat-icon">${escapeHtml(a.icon||'💳')}</div><div class="cat-info"><div class="cat-name">${escapeHtml(a.name)}</div><div class="tx-meta">${a.type==='cash'?'Наличные':a.type==='card'?'Карта':'Другое'}</div></div><div class="cat-sum">${fmt(a.balance)}</div></div>`).join('')||'<div class="empty">Нет счетов</div>';}

function renderTxList(el,rows,canDelete){if(!rows?.length){el.innerHTML='<div class="empty">Пусто</div>';return;}el.innerHTML=rows.map(t=>{const income=t.type==='income',color=t.category_color||'#5b8def',sign=income?'+':'−',acc=t.account_name?` · ${escapeHtml(t.account_icon||'')} ${escapeHtml(t.account_name)}`:'';const action=canDelete&&t.kind!=='transfer'?`<button type="button" class="tx-delete" data-del="${t.id}">Удалить</button>`:'';return `<div class="tx-swipe-wrap" data-id="${t.id}"><div class="tx-row"><div class="tx-icon" style="background:${escapeHtml(color)}33">${escapeHtml(t.category_icon||'💰')}</div><div class="tx-info"><div class="tx-title">${escapeHtml(t.category_name||t.note||'Операция')}</div><div class="tx-meta">${escapeHtml(t.date)}${acc}${t.note&&t.category_name?' · '+escapeHtml(t.note):''}</div></div><div class="tx-amount ${income?'income':'expense'}">${sign}${fmt(t.amount)}</div></div>${action}</div>`;}).join('');el.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',()=>deleteTx(b.dataset.del)));}

async function deleteTx(id){if(!confirm('Удалить операцию?'))return;await withBusy(`delete:${id}`,async()=>{try{await api(`/transactions/${id}`,{method:'DELETE'});haptic();await loadDashboard();await loadAllTx();}catch(e){alert(e.message);}});}

async function loadDashboard(){const d=await api('/dashboard');document.getElementById('greet').textContent=d.name?`Привет, ${d.name}`:'Привет';document.getElementById('balance').textContent=fmt(d.balance);document.getElementById('monthIncome').textContent='+'+fmt(d.month.income);document.getElementById('monthExpense').textContent='−'+fmt(d.month.expense);state.accounts=d.accounts||[];fillAccounts();document.getElementById('accounts-mini').innerHTML=state.accounts.map(a=>`<span>${escapeHtml(a.icon||'')} ${escapeHtml(a.name)}: ${fmt(a.balance)}</span>`).join('');
 const max=Math.max(...(d.byCategory||[]).map(c=>Number(c.total)||0),1);const chart=document.getElementById('categories-chart');chart.innerHTML=d.byCategory?.length?d.byCategory.map(c=>{const color=/^#[0-9a-f]{6}$/i.test(c.color||'')?c.color:'#5b8def';return `<div class="cat-row"><div class="cat-icon" style="background:${color}33">${escapeHtml(c.icon||'💰')}</div><div class="cat-info"><div class="cat-name">${escapeHtml(c.name||'Без категории')}</div><div class="cat-bar-wrap"><div class="cat-bar" style="width:${Math.min(100,(c.total/max)*100)}%;background:${color}"></div></div></div><div class="cat-sum">${fmt(c.total)}</div></div>`;}).join(''):'<div class="empty">Пока нет расходов в этом месяце</div>';
 renderTxList(document.getElementById('recent-list'),d.recent,false);await loadMonthsChart();}
async function loadMonthsChart(){const data=await api('/stats/months?months=6');const max=Math.max(...data.flatMap(m=>[m.income,m.expense]).map(Number),1);document.getElementById('months-chart').innerHTML=data.map(m=>`<div class="month-col"><div class="month-bars"><div class="month-bar inc" style="height:${Math.round((m.income/max)*90)}px"></div><div class="month-bar exp" style="height:${Math.round((m.expense/max)*90)}px"></div></div><div class="month-label">${escapeHtml(m.label.slice(0,2))}</div></div>`).join('');}

async function loadAllTx(){renderTxList(document.getElementById('all-tx'),await api('/transactions?limit=50'),true);}
async function loadBudgets(){const rows=await api('/budgets');document.getElementById('budget-list').innerHTML=rows.map(b=>{const pct=b.amount?Math.min(100,b.spent/b.amount*100):0;return `<div class="cat-row"><div class="cat-icon">${escapeHtml(b.icon||'📊')}</div><div class="cat-info"><div class="cat-name">${escapeHtml(b.name)}</div><div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%"></div></div><div class="tx-meta">${fmt(b.spent)} из ${fmt(b.amount)}</div></div></div>`;}).join('')||'<div class="empty">Лимитов пока нет</div>';}
async function loadPiggies(){const rows=await api('/piggies');const el=document.getElementById('piggy-list');el.innerHTML=rows.length?rows.map(p=>{const pct=p.goal?Math.min(100,p.balance/p.goal*100):0;return `<div class="piggy-card"><div class="piggy-head"><div class="icon">${escapeHtml(p.icon||'🏦')}</div><div><div class="name">${escapeHtml(p.name)}</div><div class="goal">Цель: ${fmt(p.goal)}</div></div></div><div class="piggy-progress"><div style="width:${pct}%"></div></div><div class="piggy-foot"><div class="piggy-bal">${fmt(p.balance)}</div><div class="piggy-actions"><button data-act="deposit" data-id="${p.id}">+ Внести</button><button data-act="withdraw" data-id="${p.id}">Снять</button></div></div></div>`;}).join(''):'<div class="empty">Создай первую копилку</div>';el.querySelectorAll('button[data-act]').forEach(b=>b.addEventListener('click',()=>openModal(b.dataset.act,b.dataset.id)));}

function setSubmitText(){document.getElementById('tx-submit').textContent=state.type==='expense'?'Добавить расход':'Добавить доход';}
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',async()=>{document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));btn.classList.add('active');document.getElementById('tab-'+btn.dataset.tab).classList.add('active');try{if(btn.dataset.tab==='ops')await loadAllTx();if(btn.dataset.tab==='budget')await loadBudgets();if(btn.dataset.tab==='piggy')await loadPiggies();if(btn.dataset.tab==='more'){await loadAccounts();await loadSettings();}}catch(e){alert(e.message);}}));
document.querySelectorAll('.chip').forEach(chip=>chip.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));chip.classList.add('active');state.type=chip.dataset.type;setSubmitText();fillCategories();}));

document.getElementById('tx-date').value=localDate();
document.getElementById('tx-form').addEventListener('submit',async e=>{e.preventDefault();await withBusy('tx-create',async()=>{try{const amount=Number(document.getElementById('tx-amount').value),category_id=Number(document.getElementById('tx-category').value),account_id=Number(document.getElementById('tx-account').value),date=document.getElementById('tx-date').value,note=document.getElementById('tx-note').value.trim();const key=`web:${crypto.randomUUID()}`;await api('/transactions',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({amount,type:state.type,category_id,account_id,date,note,idempotency_key:key})});e.target.reset();document.getElementById('tx-date').value=localDate();haptic();await loadDashboard();await loadAllTx();}catch(err){alert(err.message);}});});

document.getElementById('budget-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/budgets',{method:'POST',body:JSON.stringify({category_id:Number(document.getElementById('budget-category').value),amount:Number(document.getElementById('budget-amount').value)})});document.getElementById('budget-amount').value='';await loadBudgets();await loadDashboard();}catch(err){alert(err.message);}});
document.getElementById('account-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/accounts',{method:'POST',body:JSON.stringify({name:document.getElementById('acc-name').value.trim(),type:document.getElementById('acc-type').value})});document.getElementById('acc-name').value='';await loadAccounts();await loadDashboard();}catch(err){alert(err.message);}});
document.getElementById('transfer-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/accounts/transfer',{method:'POST',body:JSON.stringify({from_id:Number(document.getElementById('tr-from').value),to_id:Number(document.getElementById('tr-to').value),amount:Number(document.getElementById('tr-amount').value),date:localDate()})});e.target.reset();haptic();await loadAccounts();await loadDashboard();}catch(err){alert(err.message);}});

document.getElementById('btn-parse-sms').addEventListener('click',async()=>{const text=document.getElementById('sms-text').value.trim();if(!text)return setStatus('Вставьте текст SMS');setStatus('Распознаю SMS…');try{const r=await api('/parse-sms',{method:'POST',body:JSON.stringify({text})});await confirmAndSaveParsed(r,text.slice(0,80));document.getElementById('sms-text').value='';}catch(e){setStatus(e.message);}});
function setStatus(s){document.getElementById('sms-status').textContent=s||'';}
async function confirmAndSaveParsed(r,fallback){const msg=`${r.type==='income'?'+':'−'}${fmt(r.amount)} · ${r.type==='income'?'доход':'расход'}\n${r.category_name||'—'}\n${r.note||r.merchant||fallback||''}`;let ok=false;if(tg?.showPopup){ok=await new Promise(resolve=>tg.showPopup({title:'Записать операцию?',message:msg.slice(0,250),buttons:[{id:'yes',type:'default',text:'Записать'},{id:'no',type:'cancel',text:'Отмена'}]},id=>resolve(id==='yes')));}else ok=confirm(msg);if(!ok)return setStatus('Отменено');const acc=state.accounts[0];await api('/transactions',{method:'POST',headers:{'Idempotency-Key':`parse:${crypto.randomUUID()}`},body:JSON.stringify({amount:r.amount,type:r.type,category_id:r.category_id,account_id:acc?.id,note:r.note||r.merchant||fallback,date:r.date||localDate()})});setStatus('Записано ✓');haptic();await loadDashboard();}

function readFile(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Не удалось прочитать файл'));r.readAsDataURL(file);});}
document.getElementById('receipt-file').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;document.getElementById('receipt-preview').style.display='block';document.getElementById('receipt-preview').textContent=`Файл: ${file.name} (${Math.round(file.size/1024)} КБ)`;try{if(file.size>7_000_000)throw new Error('Файл больше 7 МБ');const data=await readFile(file);const image=file.type.startsWith('image/')||/^data:image\//.test(data);const pdf=file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf');if(!image&&!pdf)throw new Error('Нужны JPG/PNG/WEBP или PDF');setStatus('Распознаю чек…');const r=await api('/parse-receipt',{method:'POST',body:JSON.stringify(image?{image}:{pdfBase64:data})});await confirmAndSaveParsed(r,file.name);}catch(err){setStatus(err.message);alert(err.message);}finally{e.target.value='';}});


async function loadSettings(){const s=await api('/settings');document.getElementById('remind-enabled').checked=!!s.remind_enabled;const sel=document.getElementById('remind-hour');if(!sel.options.length)for(let h=0;h<24;h++){const o=document.createElement('option');o.value=h;o.textContent=`${String(h).padStart(2,'0')}:00`;sel.appendChild(o);}sel.value=s.remind_hour??21;const tz=document.getElementById('remind-timezone');if(tz&&s.timezone){if(![...tz.options].some(o=>o.value===s.timezone)){const o=document.createElement('option');o.value=s.timezone;o.textContent=s.timezone;tz.appendChild(o);}tz.value=s.timezone;}}
document.getElementById('remind-enabled').addEventListener('change',async e=>{try{await api('/settings',{method:'POST',body:JSON.stringify({remind_enabled:e.target.checked})});}catch(err){e.target.checked=!e.target.checked;alert(err.message);}});
document.getElementById('remind-hour').addEventListener('change',async e=>{try{await api('/settings',{method:'POST',body:JSON.stringify({remind_hour:Number(e.target.value),remind_enabled:true})});document.getElementById('remind-enabled').checked=true;}catch(err){alert(err.message);}});

document.getElementById('btn-new-piggy').addEventListener('click',()=>document.getElementById('piggy-form').classList.toggle('hidden'));
document.getElementById('piggy-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/piggies',{method:'POST',body:JSON.stringify({name:document.getElementById('piggy-name').value.trim(),goal:Number(document.getElementById('piggy-goal').value)||0})});e.target.reset();e.target.classList.add('hidden');await loadPiggies();}catch(err){alert(err.message);}});
function openModal(act,id){state.modal={act,id};document.getElementById('modal-title').textContent=act==='deposit'?'Пополнить копилку':'Снять с копилки';document.getElementById('modal-amount').value='';document.getElementById('modal').classList.remove('hidden');}
document.getElementById('modal-cancel').addEventListener('click',()=>{state.modal=null;document.getElementById('modal').classList.add('hidden');});
document.getElementById('modal-ok').addEventListener('click',async()=>{if(!state.modal)return;const amount=Number(document.getElementById('modal-amount').value);if(!Number.isFinite(amount)||amount<=0)return;try{await api(`/piggies/${state.modal.id}/${state.modal.act}`,{method:'POST',body:JSON.stringify({amount})});document.getElementById('modal').classList.add('hidden');state.modal=null;haptic();await loadPiggies();}catch(e){alert(e.message);}});

async function boot() {
  try {
    await loadCategories();
    await loadDashboard();
  } catch (e) {
    console.error('Mini App boot error:', e);
    const balance = document.getElementById('balance');
    const recent = document.getElementById('recent-list');
    if (balance) balance.textContent = 'Ошибка подключения';
    if (recent) recent.textContent = e?.message || 'Не удалось загрузить данные';
  }
}

const timezoneSelect = document.getElementById('remind-timezone');
if (timezoneSelect) {
  timezoneSelect.addEventListener('change', async e => {
    try {
      await api('/settings', {method:'POST', body:JSON.stringify({timezone:e.target.value})});
    } catch (err) {
      alert(err.message);
      await loadSettings().catch(() => {});
    }
  });
}

window.addEventListener('error', e => console.error('Mini App error:', e.error || e.message));
window.addEventListener('unhandledrejection', e => console.error('Mini App rejection:', e.reason));

boot();
