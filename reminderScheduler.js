import { DateTime } from 'luxon';
import { InlineKeyboard } from 'grammy';
import { getAllUsers, getUserById } from './lib/users.js';
import { listSubscriptionsForUser, shiftNextDue, updateSubscription, getSubscriptionById } from './lib/subscriptions.js';
import { formatCurrency, escapeHtml, pluralizeDays } from './lib/format.js';
import {
  formatShortDateWithWeekday,
  formatDateWithWeekday,
  calculateNextPeriodDate,
  addDays,
} from './lib/dates.js';
import { logSubscriptionEvent } from './lib/events.js';
import { ensureSchema, claimReminder } from './lib/reminderLog.js';

const SCHEDULER_INTERVAL_MS = 60_000;
const EVENING_HOUR = 20;
const SNOOZE_DAYS = [1, 2, 3, 7];

const buildKey = (...parts) => parts.join('|');

const parseReminderOffsets = (reminders) => {
  if (!Array.isArray(reminders)) return [];
  return reminders
    .map((item) => {
      if (typeof item !== 'string') return null;
      const match = item.match(/^T-(\d+)$/);
      if (!match) return null;
      return Number.parseInt(match[1], 10);
    })
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((a, b) => a - b);
};

const getLocalDateKey = (dt) => dt.toFormat('yyyy-LL-dd');

const sendWeeklyDigest = async (bot, user, subscriptions, localNow) => {
  const upcoming = subscriptions
    .filter((sub) => {
      const due = DateTime.fromISO(sub.next_due, { zone: 'utc' }).setZone(user.tz || 'Europe/Moscow');
      const diff = Math.floor(due.startOf('day').diff(localNow.startOf('day'), 'days').days);
      return diff >= 0 && diff <= 6;
    })
    .sort((a, b) => (a.next_due < b.next_due ? -1 : 1));

  if (upcoming.length === 0) {
    return;
  }

  const lines = upcoming.map((sub) => `${formatShortDateWithWeekday(sub.next_due, user.tz)} — ${escapeHtml(sub.name)} ${formatCurrency(sub.amount, sub.currency)}`);

  const totals = upcoming.reduce((acc, sub) => {
    acc[sub.currency] = (acc[sub.currency] || 0) + sub.amount;
    return acc;
  }, {});

  const totalLine = Object.entries(totals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatCurrency(amount, currency))
    .join(', ');

  const message = [
    'На этой неделе:',
    '',
    ...lines,
    '',
    `Итого за неделю: ${totalLine}`,
  ].join('\n');

  await bot.api.sendMessage(user.user_id, message);
};

const sendPreReminder = async (bot, user, sub, daysBefore) => {
  const weekday = formatShortDateWithWeekday(sub.next_due, user.tz);
  const message = `Через ${daysBefore} ${pluralizeDays(daysBefore)} спишется: ${escapeHtml(sub.name)} — ${formatCurrency(sub.amount, sub.currency)} (${weekday}).`;
  await bot.api.sendMessage(user.user_id, message, { parse_mode: 'HTML' });
};

const sendMorningReminder = async (bot, user, sub) => {
  const weekday = formatShortDateWithWeekday(sub.next_due, user.tz);
  const message = `Сегодня спишется: ${escapeHtml(sub.name)} — ${formatCurrency(sub.amount, sub.currency)} (${weekday}).`;
  await bot.api.sendMessage(user.user_id, message, { parse_mode: 'HTML' });
};

const buildEveningKeyboard = (subscriptionId) => {
  const keyboard = new InlineKeyboard()
    .text('Оплатил', `pay:${subscriptionId}`)
    .text('Отложить', `snooze:${subscriptionId}`)
    .row()
    .text('Пропустить цикл', `skip:${subscriptionId}`);
  return keyboard;
};

const sendEveningCheck = async (bot, user, sub) => {
  const message = `${escapeHtml(sub.name)} — ${formatCurrency(sub.amount, sub.currency)} сегодня. Оплата прошла?`;
  await bot.api.sendMessage(user.user_id, message, {
    parse_mode: 'HTML',
    reply_markup: buildEveningKeyboard(sub.id),
  });
};

const shouldSend = async (key) => claimReminder(key);

const processUserReminders = async (bot, user, subscriptions, utcNow) => {
  const tz = user.tz || 'Europe/Moscow';
  const localNow = utcNow.setZone(tz);
  const dateKey = getLocalDateKey(localNow);

  // Weekly digest
  if (localNow.weekday === 1 && localNow.hour === user.notify_hour && localNow.minute === 0) {
    const key = buildKey(user.user_id, 'weekly', dateKey);
    if (await shouldSend(key)) {
      await sendWeeklyDigest(bot, user, subscriptions, localNow).catch((err) => {
        console.error('Failed to send weekly digest', { err, userId: user.user_id });
      });
    }
  }

  for (const sub of subscriptions) {
    const due = DateTime.fromISO(sub.next_due, { zone: 'utc' }).setZone(tz);
    if (!due.isValid) continue;

    const diffDays = Math.floor(due.startOf('day').diff(localNow.startOf('day'), 'days').days);

    const reminderOffsets = parseReminderOffsets(sub.reminders);
    const shouldSendPreNow = localNow.hour === user.notify_hour && localNow.minute === 0;
    for (const offset of reminderOffsets) {
      if (offset <= 0) continue;
      if (diffDays !== offset) continue;
      if (!shouldSendPreNow) continue;
      const key = buildKey(user.user_id, sub.id, `pre-${offset}`, dateKey);
      if (await shouldSend(key)) {
        sendPreReminder(bot, user, sub, offset).catch((err) => {
          console.error('Failed to send pre-reminder', err);
        });
      }
    }

    // Morning reminder (T0)
    if (diffDays === 0 && localNow.hour === user.notify_hour && localNow.minute === 0) {
      const key = buildKey(user.user_id, sub.id, 'morning', dateKey);
      if (await shouldSend(key)) {
        sendMorningReminder(bot, user, sub).catch((err) => {
          console.error('Failed to send morning reminder', err);
        });
      }
    }

    // Evening check at 20:00 local time
    if (diffDays === 0 && localNow.hour === EVENING_HOUR && localNow.minute === 0) {
      const key = buildKey(user.user_id, sub.id, 'evening', dateKey);
      if (await shouldSend(key)) {
        sendEveningCheck(bot, user, sub).catch((err) => {
          console.error('Failed to send evening check', err);
        });
      }
    }
  }
};

export const startReminderScheduler = async (bot) => {
  await ensureSchema();
  const tick = async () => {
    const utcNow = DateTime.utc();
    let users;
    try {
      users = await getAllUsers();
    } catch (error) {
      console.error('Failed to load users for reminders', error);
      return;
    }

    for (const user of users) {
      let subscriptions;
      try {
        subscriptions = await listSubscriptionsForUser(user.user_id);
      } catch (error) {
        console.error('Failed to load subscriptions for reminders', { error, userId: user.user_id });
        continue;
      }

      if (!subscriptions.length) {
        continue;
      }

      await processUserReminders(bot, user, subscriptions, utcNow);
    }
  };

  // initial kick
  await tick().catch((err) => console.error('Reminder tick failed', err));
  return setInterval(() => {
    tick().catch((err) => console.error('Reminder tick failed', err));
  }, SCHEDULER_INTERVAL_MS);
};

export const handleMarkPaid = async (ctx, subscription) => {
  const nextDate = calculateNextPeriodDate({ currentDate: subscription.next_due, period: subscription.period });
  await updateSubscription(subscription.id, { next_due: nextDate });
  await logSubscriptionEvent({ subscriptionId: subscription.id, date: DateTime.utc().toISODate(), status: 'paid' });
  await ctx.editMessageText(`✅ ${escapeHtml(subscription.name)} — отмечена как оплаченная. Следующая дата: ${formatDateWithWeekday(nextDate, subscription.tz || 'Europe/Moscow')}`, {
    parse_mode: 'HTML',
  }).catch(async () => {
    await ctx.reply(`✅ ${escapeHtml(subscription.name)} — отмечена как оплаченная. Следующая дата: ${formatDateWithWeekday(nextDate, subscription.tz || 'Europe/Moscow')}`, {
      parse_mode: 'HTML',
    });
  });
};

export const handleSkipCycle = async (ctx, subscription) => {
  const nextDate = calculateNextPeriodDate({ currentDate: subscription.next_due, period: subscription.period });
  await updateSubscription(subscription.id, { next_due: nextDate });
  await logSubscriptionEvent({ subscriptionId: subscription.id, date: DateTime.utc().toISODate(), status: 'skipped' });
  await ctx.editMessageText(`⏭️ ${escapeHtml(subscription.name)} — цикл пропущен. Новая дата: ${formatDateWithWeekday(nextDate, subscription.tz || 'Europe/Moscow')}`, {
    parse_mode: 'HTML',
  }).catch(async () => {
    await ctx.reply(`⏭️ ${escapeHtml(subscription.name)} — цикл пропущен. Новая дата: ${formatDateWithWeekday(nextDate, subscription.tz || 'Europe/Moscow')}`, {
      parse_mode: 'HTML',
    });
  });
};

export const handleSnooze = async (ctx, subscription, days) => {
  const newDate = addDays(subscription.next_due, days);
  await shiftNextDue({ id: subscription.id, userId: subscription.user_id, nextDue: newDate });
  await ctx.editMessageText(`🕒 ${escapeHtml(subscription.name)} — перенёс на ${formatDateWithWeekday(newDate, subscription.tz || 'Europe/Moscow')}`, {
    parse_mode: 'HTML',
  }).catch(async () => {
    await ctx.reply(`🕒 ${escapeHtml(subscription.name)} — перенёс на ${formatDateWithWeekday(newDate, subscription.tz || 'Europe/Moscow')}`, {
      parse_mode: 'HTML',
    });
  });
};

export const handleCustomSnoozePrompt = async (ctx, subscriptionId) => {
  const keyboard = new InlineKeyboard();
  SNOOZE_DAYS.forEach((days) => {
    keyboard.text(`${days}`, `snooze_option:${subscriptionId}:${days}`);
  });
  keyboard.row().text('Другое', `snooze_other:${subscriptionId}`);
  await ctx.reply('На сколько дней отложить?', { reply_markup: keyboard });
};

export const fetchSubscriptionWithUser = async (subscriptionId) => {
  const subscription = await getSubscriptionById(subscriptionId);
  if (!subscription) return null;
  const user = await getUserById(subscription.user_id);
  if (!user) return null;
  return { subscription: { ...subscription, tz: user.tz }, user };
};
