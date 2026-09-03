import * as svc from './service.js';

const fmt = (n) => `${new Intl.NumberFormat('ru-RU').format(Math.round(n))} ₽`;

/** @param {() => import('grammy').Bot|null} getBot */
export function startReminderScheduler(getBot) {
  const tick = async () => {
    const bot = getBot();
    if (!bot) return;
    let users;
    try {
      users = svc.usersToRemind();
    } catch (e) {
      return console.error('reminders query', e.message);
    }

    for (const user of users) {
      try {
        const tz = svc.tzOf(user);
        const today = svc.todayIn(tz);
        const hour = svc.localHourIn(tz);
        if (hour !== (user.remind_hour ?? 21)) continue;
        if (user.last_remind_date === today) continue;

        const s = svc.daySummary(user, today);
        const month = svc.dashboard(user).month;
        svc.markReminded(user.id, today);

        await bot.api.sendMessage(
          user.telegram_id,
          `📅 Итоги дня (${s.date})\n` +
            `Операций: ${s.count}\n` +
            `Доходы: +${fmt(s.income)}\nРасходы: −${fmt(s.expense)}\n\n` +
            `За месяц: +${fmt(month.income)} / −${fmt(month.expense)}`
        );
      } catch (e) {
        console.warn('reminder to', user.telegram_id, e.message);
      }
    }
    svc.cleanupDrafts();
  };

  const timer = setInterval(() => { tick().catch((e) => console.error('reminders', e)); }, 60_000);
  timer.unref();
  return timer;
}
