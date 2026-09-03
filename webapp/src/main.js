// Инициализация Telegram WebApp SDK
const tg = window.Telegram?.WebApp;

// Хранилище состояния Mini App
const state = {
  activeTab: 'overview',
  transactionType: 'expense',
  transactions: [],
  budgets: [],
  savings: []
};

/**
 * Инициализация Telegram WebApp и полноэкранного режима
 */
export function initTelegramApp() {
  if (!tg) {
    console.warn('Telegram WebApp SDK не обнаружен (запуск в браузере)');
    return;
  }

  try {
    // 1. Подтверждаем готовность приложения
    tg.ready();

    // 2. Раскрываем область видимости
    tg.expand();

    // 3. Запрашиваем полноэкранный режим (Bot API 8.0+)
    if (typeof tg.requestFullscreen === 'function') {
      tg.requestFullscreen();
    }

    // 4. Отключаем свайп вниз для предотвращения закрытия при тапах по кнопкам
    if (typeof tg.disableVerticalSwipes === 'function') {
      tg.disableVerticalSwipes();
    }

    // 5. Устанавливаем системные цвета
    if (tg.colorScheme) {
      document.body.classList.add(tg.colorScheme);
    }
    tg.setHeaderColor?.('secondary_bg_color');
    tg.setBackgroundColor?.('bg_color');

    // Отображаем имя пользователя из Telegram, если доступно
    const user = tg.initDataUnsafe?.user;
    const usernameEl = document.getElementById('username');
    if (usernameEl && user) {
      usernameEl.textContent = user.first_name || user.username || 'Пользователь';
    }
  } catch (err) {
    console.error('Ошибка инициализации Telegram WebApp:', err);
  }
}

/**
 * Универсальный безопасный обработчик нажатий для мобильных устройств
 */
export function bindClick(elementOrId, handler) {
  const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
  if (!el) return;

  let handled = false;

  const execute = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Виброотклик Telegram при нажатии на кнопку
    if (tg?.HapticFeedback) {
      tg.HapticFeedback.impactOccurred('light');
    }

    handler(e);
  };

  el.addEventListener('touchend', (e) => {
    handled = true;
    execute(e);
    setTimeout(() => { handled = false; }, 300);
  }, { passive: false });

  el.addEventListener('click', (e) => {
    if (!handled) {
      execute(e);
    }
  });
}

/**
 * Настройка переключения вкладок
 */
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach((btn) => {
    bindClick(btn, () => {
      const targetTab = btn.getAttribute('data-tab');
      if (!targetTab) return;

      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const activeContent = document.getElementById(`tab-${targetTab}`);
      if (activeContent) {
        activeContent.classList.add('active');
      }

      state.activeTab = targetTab;
    });
  });
}

/**
 * Настройка модального окна добавления транзакций
 */
function setupModal() {
  const modal = document.getElementById('modal-transaction');
  const btnClose = document.getElementById('btn-close-modal');
  const btnCancel = document.getElementById('btn-cancel-transaction');
  const btnQuickExpense = document.getElementById('btn-quick-expense');
  const btnQuickIncome = document.getElementById('btn-quick-income');
  const form = document.getElementById('transaction-form');
  const typeBtns = document.querySelectorAll('.type-btn');

  const openModal = (type = 'expense') => {
    state.transactionType = type;
    typeBtns.forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-type') === type);
    });
    if (modal) modal.classList.remove('hidden');
  };

  const closeModal = () => {
    if (modal) modal.classList.add('hidden');
    if (form) form.reset();
  };

  if (btnQuickExpense) bindClick(btnQuickExpense, () => openModal('expense'));
  if (btnQuickIncome) bindClick(btnQuickIncome, () => openModal('income'));
  if (btnClose) bindClick(btnClose, closeModal);
  if (btnCancel) bindClick(btnCancel, closeModal);

  // Переключение типов (Расход / Доход) внутри модального окна
  typeBtns.forEach(btn => {
    bindClick(btn, () => {
      const type = btn.getAttribute('data-type');
      state.transactionType = type;
      typeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Отправка формы транзакции
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = document.getElementById('input-amount')?.value;
      const category = document.getElementById('select-category')?.value;
      const note = document.getElementById('input-note')?.value;

      if (!amount || !category) return;

      console.log('Новая транзакция:', {
        type: state.transactionType,
        amount: parseFloat(amount),
        category,
        note,
        date: new Date().toISOString()
      });

      closeModal();
    });
  }
}

/**
 * Настройка сканера и загрузки файлов
 */
function setupScanner() {
  const btnScan = document.getElementById('btn-quick-scan');
  const btnParseSms = document.getElementById('btn-parse-sms');
  const smsInput = document.getElementById('sms-text-input');
  const fileInput = document.getElementById('receipt-file-input');

  if (btnScan) {
    bindClick(btnScan, () => {
      const scannerTabBtn = document.querySelector('.tab-btn[data-tab="scanner"]');
      if (scannerTabBtn) scannerTabBtn.click();
    });
  }

  if (btnParseSms) {
    bindClick(btnParseSms, () => {
      const text = smsInput?.value?.trim();
      if (!text) alert('Введите текст SMS для распознавания');
      else {
        console.log('Анализ SMS:', text);
        if (smsInput) smsInput.value = '';
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        console.log('Загружен файл:', file.name);
      }
    });
  }
}

// Запуск инициализации после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  initTelegramApp();
  setupTabs();
  setupModal();
  setupScanner();
});
