# Деплой Дзен-бюджет в Telegram

## Шаг 1. Бот

1. Открой [@BotFather](https://t.me/BotFather)
2. `/newbot` → имя и username → скопируй **токен**
3. Пока отложи — URL появится после хостинга

## Шаг 2. Хостинг (HTTPS)

### Вариант A — Amvera

1. Создай приложение (Node.js)
2. Загрузи код репозитория / zip
3. Переменные окружения:
   - `BOT_TOKEN` = токен бота
   - `WEBAPP_URL` = `https://<твой-поддомен>.amvera.io`
   - `PORT` = `80`
   - `RUN_BOT` = `1`
   - `NODE_ENV` = `production`
4. `amvera.yml` уже в проекте — соберёт webapp и запустит сервер+бот

### Вариант B — Railway / Render / VPS

```bash
npm install
cd webapp && npm install && npm run build && cd ..
# env: BOT_TOKEN, WEBAPP_URL, PORT, RUN_BOT=1
node server/index.js
```

## Шаг 3. Привязка Mini App

В BotFather:

1. `/newapp` → выбери бота
2. Title: `Дзен-бюджет`
3. Description: учёт финансов
4. **Web App URL**: `https://твой-домен/`
5. Опционально фото 640×360

Меню бота:

```
/setmenubutton
```

→ выбери бота → Web App → тот же URL → текст «💰 Бюджет»

## Шаг 4. Проверка

1. Открой бота → Start → кнопка «Открыть бюджет»
2. Добавь тестовый расход
3. `/remind on` → `/today`

## Локально без Telegram

```bash
npm install
cd webapp && npm install && npm run dev
# другой терминал:
npm run dev
```

Открой http://localhost:5173 — авторизация `dev`.

## Важно

- Только **HTTPS** для Mini App
- `WEBAPP_URL` должен совпадать с URL в BotFather
- SQLite-файл `data/budget.db` — сделай volume/backup на проде
- Реальные Stars/платежи не подключены (не нужны для учёта)
