import 'dotenv/config';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Bot, InlineKeyboard, session } from 'grammy';
import { DateTime } from 'luxon';
import { conversations, createConversation } from '@grammyjs/conversations';
import { ensureUser, updateUser } from './lib/users.js';
import {
  createSubscription,
  deleteSubscription,
  findSubscriptionByNameAndDate,
  getUpcomingSubscriptions,
  listSubscriptionsForUser,
  updateSubscription,
  setRemindersForUser,
  getSubscriptionsDueInRange,
} from './lib/subscriptions.js';
import {
  formatCurrency,
  normalizeAmount,
  escapeHtml,
  pluralizeDays,
} from './lib/format.js';
import {
  formatDueWithPeriod,
  parseUserDate,
  isDateInPast,
  formatShortDateWithWeekday,
  formatDateWithWeekday,
  formatDateWithYear,
  formatMonthTitle,
  formatDayMonthWeekday,
  calculateNextPeriodDate,
} from './lib/dates.js';
import {
  logSubscriptionEvent,
  getLatestPaymentEvents,
  getPaidEventsForRange,
} from './lib/events.js';
import {
  startReminderScheduler,
  handleMarkPaid,
  handleSkipCycle,
  handleSnooze,
  handleCustomSnoozePrompt,
  fetchSubscriptionWithUser,
} from './reminderScheduler.js';
import { query } from './db.js';

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('BOT_TOKEN is missing. Add it to your .env file.');
  process.exit(1);
}

const DEFAULT_TZ = process.env.DEFAULT_TZ || 'Europe/Moscow';
const DEFAULT_NOTIFY_HOUR = Number.parseInt(process.env.DEFAULT_NOTIFY_HOUR || '10', 10);
const DEFAULT_REMINDERS = (process.env.DEFAULT_REMINDERS || 'T-3,T-1,T0')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const ENABLE_REMINDER_SCHEDULER = (process.env.ENABLE_REMINDER_SCHEDULER ?? 'true').toLowerCase() !== 'false';
const BOT_COMMANDS = [
  { command: 'start', description: 'онбординг и список команд' },
  { command: 'add', description: 'добавить новую подписку' },
  { command: 'list', description: 'все подписки и суммы' },
  { command: 'upcoming', description: 'списания на 7 дней вперёд' },
  { command: 'month', description: 'оплаченные и ожидающие в текущем месяце' },
  { command: 'edit', description: 'редактировать подписку' },
  { command: 'pay', description: 'отметить оплату вручную' },
  { command: 'delete', description: 'удалить подписку' },
  { command: 'reminders', description: 'управлять напоминаниями' },
  { command: 'dbstatus', description: 'проверить подключение к базе' },
];

const proxyAgent = new SocksProxyAgent('socks5://host.docker.internal:1080');
const bot = new Bot(token, {
  client: {
    baseFetchConfig: {
      agent: proxyAgent,
    },
  },
});

bot.catch((err) => {
  console.error('Bot error', err);
});

bot.use(session({ initial: () => ({ pendingSnooze: null, edit: null, pay: null, reminderTime: null }) }));
bot.use(conversations());

bot.use(async (ctx, next) => {
  if (!ctx.from) {
    return next();
  }

  try {
    const user = await ensureUser({
      userId: ctx.from.id,
      tz: DEFAULT_TZ,
      notifyHour: DEFAULT_NOTIFY_HOUR,
      defaultReminders: DEFAULT_REMINDERS,
    });
    ctx.state = ctx.state || {};
    ctx.state.user = user;
  } catch (error) {
    console.error('ensureUser failed', error);
    await ctx.reply('Что-то пошло не так при подготовке профиля. Попробуй еще раз позже.');
    return;
  }

  return next();
});

const currencyKeyboard = new InlineKeyboard()
  .text('RUB', 'currency:RUB').text('EUR', 'currency:EUR').text('USD', 'currency:USD')
  .row()
  .text('KZT', 'currency:KZT').text('BYN', 'currency:BYN');

const PRE_REMINDER_OPTIONS = [3, 2, 1];

const periodKeyboard = new InlineKeyboard()
  .text('Ежемесячно', 'period:monthly')
  .text('Ежегодно', 'period:yearly');

const POPULAR_EMOJIS = ['🫀', '💰', '🎵', '🎮', '📱', '☁️', '🌍', '🎾', '📺', '💳', '☎️', '✈️', '🏋️', '📚', '🎬'];
const DEFAULT_EMOJI = '▫️';

const buildEmojiKeyboard = () => {
  const keyboard = new InlineKeyboard();
  POPULAR_EMOJIS.forEach((emoji, index) => {
    keyboard.text(emoji, `emoji:${emoji}`);
    if ((index + 1) % 5 === 0) {
      keyboard.row();
    }
  });
  keyboard.row().text('Свой эмодзи', 'emoji:custom');
  keyboard.row().text('Пропустить', 'emoji:skip');
  return keyboard;
};

const mergeKeyboard = () => new InlineKeyboard()
  .text('Обновить существующую', 'merge:update')
  .row()
  .text('Создать отдельную', 'merge:create')
  .row()
  .text('Отмена', 'merge:cancel');

const extractEmoji = (text) => {
  if (!text) return null;
  const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/gu;
  const matches = text.match(emojiRegex);
  return matches?.[0] || null;
};

const renderSubscriptionLine = (subscription, tz) => {
  const amount = formatCurrency(subscription.amount, subscription.currency);
  const due = formatDueWithPeriod({ date: subscription.next_due, period: subscription.period, tz });
  return `${subscription.name} • ${amount} • ${due}`;
};

const parseReminderSelection = (reminders) => {
  const source = Array.isArray(reminders)
    ? reminders
    : typeof reminders === 'string'
      ? reminders.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
  return source
    .map((item) => {
      const match = typeof item === 'string' ? item.match(/^T-(\d+)$/) : null;
      if (!match) return null;
      return Number.parseInt(match[1], 10);
    })
    .filter((value) => Number.isInteger(value) && value > 0);
};

const toReminderStrings = (offsets) => offsets
  .slice()
  .sort((a, b) => a - b)
  .map((value) => `T-${value}`);

const buildRemindersKeyboard = (activeSet) => {
  const keyboard = new InlineKeyboard();
  PRE_REMINDER_OPTIONS.forEach((offset) => {
    const isActive = activeSet.has(offset);
    const label = `${isActive ? '✅' : '❌'} T-${offset}`;
    keyboard.text(label, `reminders:toggle:${offset}`);
  });
  keyboard.row().text('Изменить время', 'reminders:change-time');
  keyboard.row().text('Закрыть', 'reminders:close');
  return keyboard;
};

const formatHour = (hour) => String(hour).padStart(2, '0');

const renderRemindersMessage = (user, activeSet) => {
  const notifyHour = user?.notify_hour ?? DEFAULT_NOTIFY_HOUR;
  const lines = PRE_REMINDER_OPTIONS.map((offset) => {
    const isActive = activeSet.has(offset);
    const status = isActive ? '✅' : '❌';
    return `${status} За ${offset} ${pluralizeDays(offset)} до списания (в ${formatHour(notifyHour)}:00)`;
  });

  const tz = user?.tz || DEFAULT_TZ;

  return [
    '<b>Напоминания перед списанием</b>',
    ...lines,
    '',
    `Предварительные и утренние напоминания отправляем в ${formatHour(notifyHour)}:00 по ${tz}, вечерняя проверка — в 20:00.`,
    'Используй кнопки ниже, чтобы менять дни и время напоминаний.',
  ].join('\n');
};

const buildEditSubscriptionsKeyboard = (subs) => {
  const keyboard = new InlineKeyboard();
  subs.forEach((sub, index) => {
    const label = `${sub.name} • ${formatCurrency(sub.amount, sub.currency)}`;
    keyboard.text(label, `edit:select:${sub.id}`);
    if ((index + 1) % 2 === 0) {
      keyboard.row();
    }
  });
  keyboard.row().text('Отмена', 'edit:cancel');
  return keyboard;
};

const buildEditFieldKeyboard = (subscriptionId) => new InlineKeyboard()
  .text('Название', `edit:field:name:${subscriptionId}`)
  .text('Стоимость', `edit:field:amount:${subscriptionId}`)
  .row()
  .text('Дата списания', `edit:field:date:${subscriptionId}`)
  .text('Периодичность', `edit:field:period:${subscriptionId}`)
  .row()
  .text('Эмодзи', `edit:field:emoji:${subscriptionId}`)
  .row()
  .text('Отмена', 'edit:cancel');

const cancelInlineKeyboard = new InlineKeyboard().text('Отмена', 'edit:cancel');
const reminderTimeCancelKeyboard = new InlineKeyboard().text('Отмена', 'reminders:cancel-time');

const sendEditFieldMenu = async (ctx, subscription) => {
  ctx.session.edit = { subscriptionId: subscription.id };
  await ctx.reply(`Редактируем ${escapeHtml(subscription.name)}. Что хочешь отредактировать?`, {
    parse_mode: 'HTML',
    reply_markup: buildEditFieldKeyboard(subscription.id),
  });
};

const loadSubscriptionForEdit = async (ctx, subscriptionId) => {
  const data = await fetchSubscriptionWithUser(subscriptionId);
  if (!data) {
    if (ctx.session) {
      ctx.session.edit = null;
      ctx.session.pay = null;
    }
    await ctx.reply('Не нашёл подписку. Обнови список /list.');
    return null;
  }
  return data;
};

const finishEditWithMenu = async (ctx, subscription) => {
  await sendEditFieldMenu(ctx, subscription);
};

const buildPaySubscriptionsKeyboard = (subs) => {
  const keyboard = new InlineKeyboard();
  subs.forEach((sub, index) => {
    const label = `${sub.name} • ${formatCurrency(sub.amount, sub.currency)}`;
    keyboard.text(label, `pay:select:${sub.id}`);
    if ((index + 1) % 2 === 0) {
      keyboard.row();
    }
  });
  keyboard.row().text('Отмена', 'pay:cancel');
  return keyboard;
};

const buildPayDateKeyboard = (subscriptionId) => new InlineKeyboard()
  .text('Сегодня', `pay:date:today:${subscriptionId}`)
  .row()
  .text('Отмена', 'pay:cancel');

const completeManualPayment = async (ctx, subscription, user, paymentDate) => {
  try {
    await logSubscriptionEvent({ subscriptionId: subscription.id, date: paymentDate, status: 'paid' });
  } catch (error) {
    console.error('Failed to log manual payment', { error, subscriptionId: subscription.id });
    await ctx.reply('Не получилось отметить оплату. Попробуй позже.');
    ctx.session.pay = null;
    return;
  }

  const suggested = calculateNextPeriodDate({ currentDate: paymentDate, period: subscription.period });
  const tz = user?.tz || DEFAULT_TZ;
  const formattedSuggested = DateTime.fromISO(suggested, { zone: 'utc' }).setZone(tz).toFormat('dd.MM');
  const paymentHuman = formatDayMonthWeekday(paymentDate, tz);

  await ctx.reply(`Оплату за ${escapeHtml(subscription.name)} отмечаю на ${paymentHuman}. Следующее списание перенёс на ${formattedSuggested}.`, {
    parse_mode: 'HTML',
  });

  try {
    await updateSubscription(subscription.id, { next_due: suggested });
  } catch (error) {
    console.error('Failed to auto-update next due after manual payment', { error, subscriptionId: subscription.id });
    await ctx.reply('Не получилось обновить дату следующего списания.');
  }

  ctx.session.pay = null;
};

const handlePayTextInput = async (ctx, text) => {
  const state = ctx.session?.pay;
  if (!state || state.stage !== 'awaitingDate') {
    return false;
  }

  if (text.startsWith('/')) {
    ctx.session.pay = null;
    return false;
  }

  if (/^отмена$/i.test(text)) {
    ctx.session.pay = null;
    await ctx.reply('Отметку оплаты отменил.');
    return true;
  }

  const data = await loadSubscriptionForEdit(ctx, state.subscriptionId);
  if (!data) {
    ctx.session.pay = null;
    return true;
  }

  const { subscription, user } = data;
  const tz = user?.tz || DEFAULT_TZ;

  let paymentDate;
  if (/^сегодня$/i.test(text)) {
    paymentDate = DateTime.now().setZone(tz).toISODate();
  } else {
    const parsed = parseUserDate(text, tz, { allowPast: true });
    if (!parsed) {
      await ctx.reply('Не распознал дату. Пример: 12.10.2024', { reply_markup: buildPayDateKeyboard(subscription.id) });
      return true;
    }
    paymentDate = parsed;
  }

  await completeManualPayment(ctx, subscription, user, paymentDate);
  return true;
};

const handleEditTextInput = async (ctx, text) => {
  const state = ctx.session?.edit;
  if (!state?.pending) {
    return false;
  }

  if (text.startsWith('/')) {
    ctx.session.edit = null;
    return false;
  }

  if (/^отмена$/i.test(text)) {
    ctx.session.edit = null;
    await ctx.reply('Редактирование отменено');
    return true;
  }

  const data = await loadSubscriptionForEdit(ctx, state.subscriptionId);
  if (!data) {
    return true;
  }

  const { subscription, user } = data;
  const tz = user?.tz || DEFAULT_TZ;

  if (state.pending === 'name') {
    const value = text.trim();
    if (!value) {
      await ctx.reply('Нужно ненулевое название. Попробуй ещё раз.', { reply_markup: cancelInlineKeyboard });
      return true;
    }

    let updated;
    try {
      updated = await updateSubscription(subscription.id, { name: value });
    } catch (error) {
      console.error('Failed to update name', { error, subscriptionId: subscription.id });
      await ctx.reply('Не получилось обновить название. Попробуй позже.');
      ctx.session.edit = null;
      return true;
    }

    ctx.session.edit = { subscriptionId: subscription.id };
    await ctx.reply(`Название успешно изменено на ${escapeHtml(value)}`, { parse_mode: 'HTML' });
    await finishEditWithMenu(ctx, updated || { ...subscription, name: value });
    return true;
  }

  if (state.pending === 'amount') {
    const parsed = normalizeAmount(text);
    if (!parsed) {
      await ctx.reply('Не похоже на число. Попробуй ещё раз.', { reply_markup: cancelInlineKeyboard });
      return true;
    }

    let updated;
    try {
      updated = await updateSubscription(subscription.id, { amount: parsed });
    } catch (error) {
      console.error('Failed to update amount', { error, subscriptionId: subscription.id });
      await ctx.reply('Не получилось обновить стоимость. Попробуй позже.');
      ctx.session.edit = null;
      return true;
    }

    ctx.session.edit = { subscriptionId: subscription.id };
    await ctx.reply(`Стоимость успешно изменена на ${formatCurrency(parsed, subscription.currency)}`);
    await finishEditWithMenu(ctx, updated || { ...subscription, amount: parsed });
    return true;
  }

  if (state.pending === 'date') {
    const parsedDate = parseUserDate(text, tz);
    if (!parsedDate) {
      await ctx.reply('Не распознал дату. Пример: 12.10.2024 или 12.10', { reply_markup: cancelInlineKeyboard });
      return true;
    }

    if (isDateInPast(parsedDate, tz)) {
      await ctx.reply('Дата уже в прошлом. Укажи будущую.', { reply_markup: cancelInlineKeyboard });
      return true;
    }

    let updated;
    try {
      updated = await updateSubscription(subscription.id, { next_due: parsedDate });
    } catch (error) {
      console.error('Failed to update date', { error, subscriptionId: subscription.id });
      await ctx.reply('Не получилось обновить дату. Попробуй позже.');
      ctx.session.edit = null;
      return true;
    }

    ctx.session.edit = { subscriptionId: subscription.id };
    await ctx.reply(`Дата списания успешно изменена на ${formatDateWithWeekday(parsedDate, tz)}`);
    await finishEditWithMenu(ctx, updated || { ...subscription, next_due: parsedDate });
    return true;
  }

  if (state.pending === 'emoji') {
    const extracted = extractEmoji(text);
    if (!extracted) {
      await ctx.reply('Не нашел эмодзи в сообщении. Попробуй еще раз.', { reply_markup: cancelInlineKeyboard });
      return true;
    }

    let updated;
    try {
      updated = await updateSubscription(subscription.id, { emoji: extracted });
    } catch (error) {
      console.error('Failed to update emoji', { error, subscriptionId: subscription.id });
      await ctx.reply('Не получилось обновить эмодзи. Попробуй позже.');
      ctx.session.edit = null;
      return true;
    }

    ctx.session.edit = { subscriptionId: subscription.id };
    await ctx.reply(`Эмодзи успешно изменен на ${extracted}`);
    await finishEditWithMenu(ctx, updated || { ...subscription, emoji: extracted });
    return true;
  }

  return false;
};

const handleReminderTimeInput = async (ctx, text) => {
  const state = ctx.session?.reminderTime;
  if (!state?.pending) {
    return false;
  }

  if (text.startsWith('/')) {
    ctx.session.reminderTime = null;
    return false;
  }

  if (/^отмена$/i.test(text)) {
    ctx.session.reminderTime = null;
    await ctx.reply('Изменение времени отменено.');
    return true;
  }

  const hour = Number.parseInt(text, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    await ctx.reply('Нужно число от 0 до 23. Попробуй ещё раз.', { reply_markup: reminderTimeCancelKeyboard });
    return true;
  }

  const user = ctx.state.user;

  try {
    await updateUser({ userId: user.user_id, notifyHour: hour });
  } catch (error) {
    console.error('Failed to update reminder time', { error, userId: user.user_id });
    await ctx.reply('Не получилось сохранить время. Попробуй позже.');
    ctx.session.reminderTime = null;
    return true;
  }

  ctx.session.reminderTime = null;
  ctx.state.user.notify_hour = hour;

  const offsets = parseReminderSelection(user.default_reminders ?? DEFAULT_REMINDERS);
  const activeSet = new Set(offsets);
  const summary = renderRemindersMessage(user, activeSet);
  const keyboard = buildRemindersKeyboard(activeSet);

  await ctx.reply(`Время напоминаний обновлено на ${formatHour(hour)}:00.`);
  await ctx.reply(summary, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });

  return true;
};

async function addSubscriptionConversation(conversation, ctx) {
  const user = ctx.state.user;
  const chatId = ctx.chat.id;
  const defaults = Array.isArray(user?.default_reminders) ? user.default_reminders : DEFAULT_REMINDERS;

  await ctx.reply('Название подписки?');
  let name;
  while (!name) {
    const nameCtx = await conversation.wait();
    name = nameCtx.message?.text?.trim();
    if (!name) {
      await nameCtx.reply('Нужен текст. Попробуй снова.');
    }
  }

  await ctx.reply('Выбери эмодзи для подписки', { reply_markup: buildEmojiKeyboard() });
  let emoji = DEFAULT_EMOJI;
  const emojiCtx = await conversation.waitForCallbackQuery(/emoji:(.+)/);
  const emojiChoice = emojiCtx.match[1];
  await emojiCtx.answerCallbackQuery();
  await emojiCtx.editMessageReplyMarkup();

  if (emojiChoice === 'skip') {
    emoji = DEFAULT_EMOJI;
  } else if (emojiChoice === 'custom') {
    await ctx.reply('Отправь свой эмодзи');
    let customEmoji = null;
    while (!customEmoji) {
      const customEmojiCtx = await conversation.wait();
      const extracted = extractEmoji(customEmojiCtx.message?.text);
      if (!extracted) {
        await customEmojiCtx.reply('Не нашел эмодзи. Попробуй еще раз.');
      } else {
        customEmoji = extracted;
        emoji = customEmoji;
      }
    }
  } else {
    emoji = emojiChoice;
  }

  await ctx.reply('Выбери валюту', { reply_markup: currencyKeyboard });
  const currencyCtx = await conversation.waitForCallbackQuery(/currency:(.+)/);
  const currency = currencyCtx.match[1];
  await currencyCtx.answerCallbackQuery();

  await currencyCtx.editMessageReplyMarkup();

  await ctx.reply('Стоимость? Например: 249, 249.99 или 249,99');
  let amount;
  while (!amount) {
    const amountCtx = await conversation.wait();
    const candidate = normalizeAmount(amountCtx.message?.text ?? '');
    if (!candidate) {
      await amountCtx.reply('Не похоже на число. Введи стоимость снова.');
    } else {
      amount = candidate;
    }
  }

  const tz = user?.tz || DEFAULT_TZ;
  await ctx.reply('Дата следующего списания? (например 12.10.2024 или 12.10)');
  let nextDue;
  while (!nextDue) {
    const dateCtx = await conversation.wait();
    const parsed = parseUserDate(dateCtx.message?.text, tz);
    if (!parsed) {
      await dateCtx.reply('Не распознал дату. Формат: 12.10 или 12.10.2024');
      continue;
    }

    if (isDateInPast(parsed, tz)) {
      await dateCtx.reply('Эта дата уже в прошлом. Укажи ближайшую будущую дату.');
      continue;
    }

    nextDue = parsed;
  }

  await ctx.reply('Тип подписки?', { reply_markup: periodKeyboard });
  const periodCtx = await conversation.waitForCallbackQuery(/period:(.+)/);
  const period = periodCtx.match[1];
  await periodCtx.answerCallbackQuery();
  await periodCtx.editMessageReplyMarkup();

  const summary = `${renderSubscriptionLine({
    name,
    amount,
    currency,
    period,
    next_due: nextDue,
  }, tz)}\nВсе верно?`;

  let existing;
  try {
    existing = await findSubscriptionByNameAndDate({ userId: user.user_id, name, nextDue });
  } catch (error) {
    console.error('Ошибка при проверке дубля подписки', { error, userId: user.user_id, name, nextDue });
    await ctx.reply('Не удалось проверить существующие подписки. Попробуй позже.');
    return;
  }

  if (existing) {
    await ctx.reply(`${summary}\nУже есть подписка с таким именем на эту дату.`, {
      reply_markup: mergeKeyboard(),
    });

    const decisionCtx = await conversation.waitForCallbackQuery(/merge:(update|create|cancel)/);
    const decision = decisionCtx.match[1];
    await decisionCtx.answerCallbackQuery();
    await decisionCtx.editMessageReplyMarkup();

    if (decision === 'cancel') {
      await ctx.reply('Отменил создание.');
      return;
    }

    if (decision === 'update') {
      await updateSubscription(existing.id, {
        amount,
        currency,
        period,
        next_due: nextDue,
      });
      await ctx.reply('Обновил существующую подписку.');
      return;
    }

    if (decision === 'create') {
      let created;
      try {
        created = await createSubscription({
          userId: user.user_id,
          name,
          amount,
          currency,
          period,
          nextDue,
          reminders: defaults,
          emoji,
        });
      } catch (error) {
        console.error('Ошибка при создании подписки (ветка merge:create)', { error, userId: user.user_id, name, nextDue });
        await ctx.reply('Не получилось создать подписку. Попробуй позже.');
        return;
      }
      await ctx.reply(`Создал подписку с id ${created.id}.`);
      return;
    }

    return;
  }

  await ctx.reply(summary);
  const confirmationKeyboard = new InlineKeyboard()
    .text('Да', 'confirm:yes')
    .text('Изменить', 'confirm:no')
    .row()
    .text('Отмена', 'confirm:cancel');
  await ctx.reply('Подтверди создание', { reply_markup: confirmationKeyboard });
  const confirmCtx = await conversation.waitForCallbackQuery(/confirm:(yes|no|cancel)/);
  const answer = confirmCtx.match[1];
  await confirmCtx.answerCallbackQuery();
  await confirmCtx.editMessageReplyMarkup();

  if (answer === 'cancel') {
    await ctx.reply('Отменил создание.');
    return;
  }

  if (answer === 'no') {
    await ctx.reply('Ок, начни заново командой /add.');
    return;
  }

  let created;
  try {
    created = await createSubscription({
      userId: user.user_id,
      name,
      amount,
      currency,
      period,
      nextDue,
      reminders: defaults,
      emoji,
    });
  } catch (error) {
    console.error('Ошибка при создании подписки', { error, userId: user.user_id, name, nextDue });
    await ctx.reply('Не получилось создать подписку. Попробуй позже.');
    return;
  }

  await ctx.reply(`Готово! ${renderSubscriptionLine(created, user?.tz || DEFAULT_TZ)}`);
}

async function deleteSubscriptionConversation(conversation, ctx) {
  const user = ctx.state.user;
  const subs = await listSubscriptionsForUser(user.user_id);

  if (subs.length === 0) {
    await ctx.reply('Подписок пока нет.');
    return;
  }

  const options = subs
    .map((sub, index) => `${index + 1}. ${renderSubscriptionLine(sub, user.tz)}`)
    .join('\n');

  await ctx.reply(`Выбери подписку для удаления:\n${options}\nОтветь номером.`);

  let target;
  while (!target) {
    const answerCtx = await conversation.wait();
    const text = answerCtx.message?.text?.trim();
    const index = Number.parseInt(text, 10);

    if (!Number.isInteger(index) || index < 1 || index > subs.length) {
      await answerCtx.reply('Нужен номер из списка.');
      continue;
    }

    target = subs[index - 1];
  }

  const success = await deleteSubscription({ id: target.id, userId: user.user_id });

  if (success) {
    await ctx.reply(`Удалил ${target.name}.`);
  } else {
    await ctx.reply('Не получилось удалить. Попробуй позже.');
  }
}


bot.use(createConversation(addSubscriptionConversation));
bot.use(createConversation(deleteSubscriptionConversation));

bot.callbackQuery(/^pay:(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  const data = await fetchSubscriptionWithUser(subscriptionId);
  if (!data) {
    await ctx.reply('Не нашёл подписку. Обнови список /list.');
    return;
  }
  await handleMarkPaid(ctx, data.subscription);
});

bot.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  const data = await fetchSubscriptionWithUser(subscriptionId);
  if (!data) {
    await ctx.reply('Не нашёл подписку. Обнови список /list.');
    return;
  }
  await handleSkipCycle(ctx, data.subscription);
});

bot.callbackQuery(/^snooze:(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  ctx.session.pendingSnooze = {
    subscriptionId,
    awaitingInput: false,
  };
  await handleCustomSnoozePrompt(ctx, subscriptionId);
});

bot.callbackQuery(/^snooze_option:(\d+):(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  const days = Number.parseInt(ctx.match[2], 10);
  await ctx.answerCallbackQuery();
  const data = await fetchSubscriptionWithUser(subscriptionId);
  if (!data) {
    await ctx.reply('Не нашёл подписку. Обнови список /list.');
    return;
  }
  ctx.session.pendingSnooze = null;
  await handleSnooze(ctx, data.subscription, days);
});

bot.callbackQuery(/^snooze_other:(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  ctx.session.pendingSnooze = {
    subscriptionId,
    awaitingInput: true,
  };
  await ctx.reply('Введи, на сколько дней отложить (число от 1 до 30).');
});

bot.callbackQuery(/^edit:select:(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  const data = await loadSubscriptionForEdit(ctx, subscriptionId);
  if (!data) {
    return;
  }
  await sendEditFieldMenu(ctx, data.subscription);
});

bot.callbackQuery(/^edit:field:(name|amount|date|period|emoji):(\d+)$/, async (ctx) => {
  const field = ctx.match[1];
  const subscriptionId = Number.parseInt(ctx.match[2], 10);
  await ctx.answerCallbackQuery();
  const data = await loadSubscriptionForEdit(ctx, subscriptionId);
  if (!data) {
    return;
  }

  const { subscription, user } = data;
  const tz = user?.tz || DEFAULT_TZ;

  if (field === 'emoji') {
    ctx.session.edit = { subscriptionId, pending: 'emoji' };
    const currentEmoji = subscription.emoji || DEFAULT_EMOJI;
    const emojiKeyboard = buildEmojiKeyboard();
    emojiKeyboard.row().text('Установить дефолтный ▫️', 'edit:emoji:default');
    await ctx.reply(`Выбери новый эмодзи (текущий: ${currentEmoji})`, {
      reply_markup: emojiKeyboard,
    });
    return;
  }

  if (field === 'name') {
    ctx.session.edit = { subscriptionId, pending: 'name' };
    await ctx.reply(`Отправь новое название (текущее: ${escapeHtml(subscription.name)})`, {
      parse_mode: 'HTML',
      reply_markup: cancelInlineKeyboard,
    });
    return;
  }

  if (field === 'amount') {
    ctx.session.edit = { subscriptionId, pending: 'amount' };
    await ctx.reply(`Отправь новую стоимость (текущая: ${formatCurrency(subscription.amount, subscription.currency)})`, {
      reply_markup: cancelInlineKeyboard,
    });
    return;
  }

  if (field === 'date') {
    ctx.session.edit = { subscriptionId, pending: 'date' };
    await ctx.reply(`Отправь актуальную дату списания (текущая: ${formatDateWithWeekday(subscription.next_due, tz)})`, {
      reply_markup: cancelInlineKeyboard,
    });
    return;
  }

  if (field === 'period') {
    ctx.session.edit = { subscriptionId, pending: 'period' };
    if (subscription.period === 'monthly') {
      const keyboard = new InlineKeyboard()
        .text('Переносим в ежегодные', `edit:period:set:yearly:${subscriptionId}`)
        .row()
        .text('Отмена', 'edit:cancel');
      await ctx.reply('Че, годовую подписку купил(а)? Переносим подписку в отряд ежегодных?', {
        reply_markup: keyboard,
      });
    } else {
      const keyboard = new InlineKeyboard()
        .text('Переносим в ежемесячные', `edit:period:set:monthly:${subscriptionId}`)
        .row()
        .text('Отмена', 'edit:cancel');
      await ctx.reply('О как, переносим подписку в отряд ежемесячных?', {
        reply_markup: keyboard,
      });
    }
  }
});

bot.callbackQuery(/^edit:period:set:(monthly|yearly):(\d+)$/, async (ctx) => {
  const target = ctx.match[1];
  const subscriptionId = Number.parseInt(ctx.match[2], 10);
  await ctx.answerCallbackQuery();
  const data = await loadSubscriptionForEdit(ctx, subscriptionId);
  if (!data) {
    return;
  }

  const { subscription, user } = data;
  if (subscription.period === target) {
    await ctx.reply('Периодичность уже такая.');
    await sendEditFieldMenu(ctx, subscription);
    return;
  }

  let updated;
  try {
    updated = await updateSubscription(subscription.id, { period: target });
  } catch (error) {
    console.error('Failed to update period', { error, subscriptionId: subscription.id });
    await ctx.reply('Не получилось изменить периодичность. Попробуй позже.');
    ctx.session.edit = null;
    return;
  }

  const friendly = target === 'monthly' ? 'ежемесячную' : 'ежегодную';
  await ctx.reply(`Периодичность успешно изменена на ${friendly}`);
  await sendEditFieldMenu(ctx, updated || { ...subscription, period: target });
});

bot.callbackQuery(/^emoji:(.+)$/, async (ctx) => {
  const emojiChoice = ctx.match[1];
  await ctx.answerCallbackQuery();

  const state = ctx.session?.edit;
  if (!state?.pending || state.pending !== 'emoji') {
    return;
  }

  if (emojiChoice === 'skip') {
    await ctx.reply('Выбор эмодзи пропущен');
    ctx.session.edit = null;
    return;
  }

  if (emojiChoice === 'custom') {
    await ctx.reply('Отправь свой эмодзи в сообщении', {
      reply_markup: cancelInlineKeyboard,
    });
    return;
  }

  const data = await loadSubscriptionForEdit(ctx, state.subscriptionId);
  if (!data) {
    return;
  }

  const { subscription } = data;
  let updated;
  try {
    updated = await updateSubscription(subscription.id, { emoji: emojiChoice });
  } catch (error) {
    console.error('Failed to update emoji', { error, subscriptionId: subscription.id });
    await ctx.reply('Не получилось обновить эмодзи. Попробуй позже.');
    ctx.session.edit = null;
    return;
  }

  ctx.session.edit = { subscriptionId: subscription.id };
  await ctx.reply(`Эмодзи успешно изменен на ${emojiChoice}`);
  await sendEditFieldMenu(ctx, updated || { ...subscription, emoji: emojiChoice });
});

bot.callbackQuery('edit:emoji:default', async (ctx) => {
  await ctx.answerCallbackQuery();

  const state = ctx.session?.edit;
  if (!state?.pending || state.pending !== 'emoji') {
    return;
  }

  const data = await loadSubscriptionForEdit(ctx, state.subscriptionId);
  if (!data) {
    return;
  }

  const { subscription } = data;
  let updated;
  try {
    updated = await updateSubscription(subscription.id, { emoji: DEFAULT_EMOJI });
  } catch (error) {
    console.error('Failed to update emoji to default', { error, subscriptionId: subscription.id });
    await ctx.reply('Не получилось установить дефолтный эмодзи. Попробуй позже.');
    ctx.session.edit = null;
    return;
  }

  ctx.session.edit = { subscriptionId: subscription.id };
  await ctx.reply(`Эмодзи успешно установлен на дефолтный ${DEFAULT_EMOJI}`);
  await sendEditFieldMenu(ctx, updated || { ...subscription, emoji: DEFAULT_EMOJI });
});

bot.callbackQuery('edit:cancel', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.session) {
    ctx.session.edit = null;
  }
  try {
    await ctx.editMessageReplyMarkup();
  } catch (error) {
    // message might already be gone – ignore
  }
  await ctx.reply('Редактирование отменено');
});

bot.callbackQuery('reminders:change-time', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.reminderTime = { pending: true };
  await ctx.reply('Введи час напоминаний (0–23).', { reply_markup: reminderTimeCancelKeyboard });
});

bot.callbackQuery('reminders:cancel-time', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.session?.reminderTime) {
    ctx.session.reminderTime = null;
    await ctx.reply('Изменение времени отменено.');
  }
});

bot.callbackQuery(/^pay:select:(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  const data = await loadSubscriptionForEdit(ctx, subscriptionId);
  if (!data) {
    ctx.session.pay = null;
    return;
  }
  ctx.session.pay = { subscriptionId, stage: 'awaitingDate' };
  await ctx.reply(`Когда оплатил(а) подписку ${escapeHtml(data.subscription.name)}? Введи дату (например 12.10.2024) или нажми «Сегодня».`, {
    parse_mode: 'HTML',
    reply_markup: buildPayDateKeyboard(subscriptionId),
  });
});

bot.callbackQuery(/^pay:date:today:(\d+)$/, async (ctx) => {
  const subscriptionId = Number.parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  const data = await loadSubscriptionForEdit(ctx, subscriptionId);
  if (!data) {
    ctx.session.pay = null;
    return;
  }

  const tz = data.user?.tz || DEFAULT_TZ;
  const today = DateTime.now().setZone(tz).toISODate();
  await completeManualPayment(ctx, data.subscription, data.user, today);
});

bot.callbackQuery('pay:cancel', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const state = ctx.session?.pay;
  ctx.session.pay = null;
  await ctx.reply('Отметку оплаты отменил.');
});

bot.callbackQuery(/^reminders:toggle:(\d+)$/, async (ctx) => {
  const offset = Number.parseInt(ctx.match[1], 10);
  if (!PRE_REMINDER_OPTIONS.includes(offset)) {
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();

  const user = ctx.state.user;
  const currentOffsets = new Set(parseReminderSelection(user?.default_reminders ?? DEFAULT_REMINDERS));

  if (currentOffsets.has(offset)) {
    currentOffsets.delete(offset);
  } else {
    currentOffsets.add(offset);
  }

  const newOffsets = Array.from(currentOffsets);
  const reminderStrings = toReminderStrings(newOffsets);

  try {
    await updateUser({ userId: user.user_id, defaultReminders: reminderStrings });
    await setRemindersForUser({ userId: user.user_id, reminders: reminderStrings });
  } catch (error) {
    console.error('Failed to update reminders', { error, userId: user.user_id });
    await ctx.reply('Не получилось сохранить настройки. Попробуй позже.');
    return;
  }

  user.default_reminders = reminderStrings;

  const activeSet = new Set(newOffsets);
  const message = renderRemindersMessage(user, activeSet);
  const keyboard = buildRemindersKeyboard(activeSet);

  try {
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (error) {
    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
});

bot.callbackQuery('reminders:close', async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageReplyMarkup();
  } catch (error) {
    // message may be gone or already edited; ignore
  }
});

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();

  const editHandled = await handleEditTextInput(ctx, text);
  if (editHandled) {
    return;
  }

  const reminderTimeHandled = await handleReminderTimeInput(ctx, text);
  if (reminderTimeHandled) {
    return;
  }

  const payHandled = await handlePayTextInput(ctx, text);
  if (payHandled) {
    return;
  }

  const pending = ctx.session?.pendingSnooze;
  if (!pending?.awaitingInput) {
    return next();
  }

  if (text.startsWith('/')) {
    ctx.session.pendingSnooze = null;
    return next();
  }

  const days = Number.parseInt(text, 10);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    await ctx.reply('Нужно число от 1 до 30. Попробуй ещё раз.');
    return;
  }

  const data = await fetchSubscriptionWithUser(pending.subscriptionId);
  if (!data) {
    ctx.session.pendingSnooze = null;
    await ctx.reply('Не нашёл подписку. Обнови список /list.');
    return;
  }

  ctx.session.pendingSnooze = null;
  await handleSnooze(ctx, data.subscription, days);
});

bot.command('start', async (ctx) => {
  const user = ctx.state.user;
  const tz = user?.tz || DEFAULT_TZ;
  const hour = user?.notify_hour ?? DEFAULT_NOTIFY_HOUR;

  await ctx.reply(
    `Привет, я Recur! Помогаю держать твои подписки и повторяющиеся платежи под контролем: напоминаю о ближайших списаниях и показываю статистику по рекуррентным платежам.`,
  );

  await ctx.reply(
    `Используй эти команды, чтобы управлять мной:\n\n` +
    `*Управление подписками*\n` +
    `/add — добавить подписку\n` +
    `/edit — редактировать подписку\n` +
    `/delete — удалить подписку\n` +
    `/pay — отметить оплату вручную (если дата в боте устарела)\n\n` +
    `*Обзор и отчёты*\n` +
    `/list — все подписки и суммы\n` +
    `/upcoming — списания на 7 дней вперёд\n` +
    `/month — оплаченные и ожидающие в этом месяце\n\n` +
    `*Напоминания*\n` +
    `/reminders — управлять напоминаниями\n\n` +
    `*Служебное*\n` +
    `/start — онбординг и список команд\n` +
    `/dbstatus — статус подключения к базе\n` +
    `/timezone (soon) — изменение часового пояса\n` +
    `/export (soon) — экспорт данных в csv\n\n` +
    `Твой час уведомлений: ${hour}:00, часовой пояс: ${tz}.\n` +
    `Автор проекта — @hanumatori`,
    { parse_mode: 'Markdown' },
  );
});

bot.command('add', async (ctx) => {
  await ctx.conversation.enter('addSubscriptionConversation');
});

bot.command('delete', async (ctx) => {
  await ctx.conversation.enter('deleteSubscriptionConversation');
});

bot.command('edit', async (ctx) => {
  const user = ctx.state.user;
  const subs = await listSubscriptionsForUser(user.user_id);

  if (subs.length === 0) {
    await ctx.reply('Подписок пока нет. Добавь подписку командой /add.');
    return;
  }

  ctx.session.edit = null;
  const keyboard = buildEditSubscriptionsKeyboard(subs);
  await ctx.reply('Выбери подписку для редактирования', {
    reply_markup: keyboard,
  });
});

bot.command('pay', async (ctx) => {
  const user = ctx.state.user;
  const subs = await listSubscriptionsForUser(user.user_id);

  if (subs.length === 0) {
    await ctx.reply('Подписок пока нет.');
    return;
  }

  const tz = user?.tz || DEFAULT_TZ;
  const monthStart = DateTime.now().setZone(tz).startOf('month');
  const monthEnd = monthStart.endOf('month');
  const paidEvents = await getPaidEventsForRange({
    userId: user.user_id,
    startDate: monthStart.toISODate(),
    endDate: monthEnd.toISODate(),
  });
  const paidSet = new Set(paidEvents.map((event) => event.subscription_id));

  const availableSubs = subs.filter((sub) => !paidSet.has(sub.id));

  if (availableSubs.length === 0) {
    await ctx.reply('Все подписки уже отмечены как оплаченные в этом месяце.');
    return;
  }

  ctx.session.pay = null;
  const keyboard = buildPaySubscriptionsKeyboard(availableSubs);
  await ctx.reply('Выбери подписку, которую уже оплатил(а)', {
    reply_markup: keyboard,
  });
});

bot.command('list', async (ctx) => {
  const user = ctx.state.user;
  const subs = await listSubscriptionsForUser(user.user_id);

  if (subs.length === 0) {
    await ctx.reply('Пока пусто. Добавь подписку командой /add.');
    return;
  }

  const tz = user.tz || DEFAULT_TZ;
  const subscriptionIds = subs.map((sub) => sub.id);

  if (subscriptionIds.length) {
    const paidEvents = await getLatestPaymentEvents({
      subscriptionIds,
      fromDate: DateTime.now().minus({ years: 1 }).toISODate(),
    });

    const latestPaid = new Map();
    paidEvents.forEach((event) => {
      if (!latestPaid.has(event.subscription_id)) {
        latestPaid.set(event.subscription_id, event.event_date);
      }
    });

    for (const sub of subs) {
      const paidDate = latestPaid.get(sub.id);
      if (!paidDate) continue;

      const paidDt = DateTime.fromISO(paidDate, { zone: tz }).startOf('day');
      if (!paidDt.isValid) continue;

      let nextDue = sub.next_due;
      let dueDt = DateTime.fromISO(nextDue, { zone: tz }).startOf('day');
      if (!dueDt.isValid) continue;

      let iterations = 0;
      while (paidDt >= dueDt && iterations < 24) {
        nextDue = calculateNextPeriodDate({ currentDate: nextDue, period: sub.period });
        dueDt = DateTime.fromISO(nextDue, { zone: tz }).startOf('day');
        iterations += 1;
      }

      if (nextDue !== sub.next_due) {
        try {
          await updateSubscription(sub.id, { next_due: nextDue });
          sub.next_due = nextDue;
        } catch (error) {
          console.error('Failed to auto-roll next_due', { error, subscriptionId: sub.id });
        }
      }
    }
  }

  const monthly = subs.filter((sub) => sub.period === 'monthly');
  const yearly = subs.filter((sub) => sub.period === 'yearly');

  monthly.sort((a, b) => (a.next_due < b.next_due ? -1 : a.next_due > b.next_due ? 1 : a.name.localeCompare(b.name)));
  yearly.sort((a, b) => (a.next_due < b.next_due ? -1 : a.next_due > b.next_due ? 1 : a.name.localeCompare(b.name)));

  const monthlyTotals = {};
  const yearlyTotals = {};
  subs.forEach((sub) => {
    if (sub.period === 'monthly') {
      monthlyTotals[sub.currency] = (monthlyTotals[sub.currency] || 0) + sub.amount;
    } else if (sub.period === 'yearly') {
      yearlyTotals[sub.currency] = (yearlyTotals[sub.currency] || 0) + sub.amount;
    }
  });

  const parts = ['Вот все твои подписки:'];

  if (monthly.length) {
    const monthlyLines = monthly
      .map((sub) => {
        const dateText = formatDayMonthWeekday(sub.next_due, tz);
        const emoji = sub.emoji || DEFAULT_EMOJI;
        return [`${emoji} ${escapeHtml(sub.name)} • ${formatCurrency(sub.amount, sub.currency)}`, `🗓 след. списание ${dateText}`].join('\n');
      })
      .join('\n\n');

    parts.push('', '<b><code>Ежемесячные</code></b>');
    parts.push(monthlyLines);
  }

  if (yearly.length) {
    const yearlyLines = yearly
      .map((sub) => {
        const dateText = formatDayMonthWeekday(sub.next_due, tz);
        const emoji = sub.emoji || DEFAULT_EMOJI;
        return [`${emoji} ${escapeHtml(sub.name)} • ${formatCurrency(sub.amount, sub.currency)}`, `🗓 след. списание ${dateText}`].join('\n');
      })
      .join('\n\n');

    parts.push('', '<b><code>Ежегодные</code></b>');
    parts.push(yearlyLines);
  }

  const totalLines = [];
  Object.entries(monthlyTotals)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([currency, amount]) => {
      totalLines.push(`Все ежемесячные в месяц: <code>${formatCurrency(amount, currency)}</code>`);
    });
  Object.entries(yearlyTotals)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([currency, amount]) => {
      totalLines.push(`Все ежегодные в год: <code>${formatCurrency(amount, currency)}</code>`);
    });

  if (totalLines.length) {
    parts.push('', '<b>Итого:</b>');
    parts.push(totalLines.join('\n'));
  }

  const message = parts.filter(Boolean).join('\n\n');

  await ctx.reply(message, { parse_mode: 'HTML' });
});

bot.command('dbstatus', async (ctx) => {
  const start = Date.now();
  try {
    const { rows } = await query('select now() as now');
    const duration = Date.now() - start;
    await ctx.reply(
      `✅ Подключение к БД установлено.\n` +
      `Время ответа: ${duration} мс\n` +
      `Серверное время: ${rows[0]?.now ?? '—'}`,
    );
  } catch (error) {
    const parts = [
      '❌ Не удалось подключиться к БД.',
      `Код: ${error.code ?? 'unknown'}`,
      `Сообщение: ${error.message ?? error.toString()}`,
    ];
    if (error.errno !== undefined) {
      parts.push(`errno: ${error.errno}`);
    }
    if (error.address || error.port) {
      parts.push(`Адрес: ${error.address ?? ''}:${error.port ?? ''}`.trim());
    }
    await ctx.reply(parts.join('\n'));
  }
});

bot.command('month', async (ctx) => {
  const user = ctx.state.user;
  const tz = user?.tz || DEFAULT_TZ;
  const now = DateTime.now().setZone(tz);
  const startOfMonth = now.startOf('month');
  const endOfMonth = now.endOf('month');

  const [dueSubs, paidEventsRaw] = await Promise.all([
    getSubscriptionsDueInRange({ userId: user.user_id, startDate: startOfMonth.toISODate(), endDate: endOfMonth.toISODate() }),
    getPaidEventsForRange({ userId: user.user_id, startDate: startOfMonth.toISODate(), endDate: endOfMonth.toISODate() }),
  ]);

  const paidEvents = paidEventsRaw
    .slice()
    .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : a.name.localeCompare(b.name)));

  const paidBySubscription = new Map();
  paidEvents.forEach((event) => {
    const existing = paidBySubscription.get(event.subscription_id) || [];
    existing.push(event);
    paidBySubscription.set(event.subscription_id, existing);
  });

  const unpaid = dueSubs.filter((sub) => !paidBySubscription.has(sub.id));

  const unpaidLines = unpaid
    .sort((a, b) => (a.next_due < b.next_due ? -1 : a.next_due > b.next_due ? 1 : a.name.localeCompare(b.name)))
    .map((sub) => {
      const dateText = formatDayMonthWeekday(sub.next_due, tz);
      const emoji = sub.emoji || DEFAULT_EMOJI;
      return [`${emoji} ${escapeHtml(sub.name)} • ${formatCurrency(sub.amount, sub.currency)}`, `🗓 ${dateText}`].join('\n');
    });

  const paidLines = paidEvents
    .map((event) => {
      const dateText = formatDayMonthWeekday(event.event_date, tz);
      const emoji = event.emoji || DEFAULT_EMOJI;
      return [`${emoji} ${escapeHtml(event.name)} • ${formatCurrency(event.amount, event.currency)}`, `🗓 оплачен ${dateText}`].join('\n');
    });

  const unpaidTotals = unpaid.reduce((acc, sub) => {
    acc[sub.currency] = (acc[sub.currency] || 0) + sub.amount;
    return acc;
  }, {});

  const totalLine = Object.entries(unpaidTotals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatCurrency(amount, currency))
    .join(', ');

  const monthTitle = formatMonthTitle(startOfMonth.toISODate(), tz);
  const monthNameLower = monthTitle.split(',')[0].toLowerCase();

  const parts = [
    `<b><code>${monthTitle}</code></b>`,
  ];

  parts.push('', '<b>Ждут оплаты:</b>');
  parts.push(unpaidLines.length ? unpaidLines.join('\n\n') : 'Нет подписок');

  parts.push('', '');

  parts.push('<b>Уже оплатил:</b>');
  parts.push(paidLines.length ? paidLines.join('\n\n') : 'Нет подписок');

  const summary = totalLine ? `Осталось за ${monthNameLower}: ${totalLine}` : `Осталось за ${monthNameLower}: 0`;
  parts.push('', '', `<b>${summary}</b>`);

  await ctx.reply(parts.join('\n'), { parse_mode: 'HTML' });
});

bot.command('upcoming', async (ctx) => {
  const user = ctx.state.user;
  const tz = user.tz || DEFAULT_TZ;
  const upcoming = await getUpcomingSubscriptions({ userId: user.user_id, days: 7 });

  if (upcoming.length === 0) {
    await ctx.reply('В ближайшие 7 дней списаний нет.');
    return;
  }

  const subscriptionIds = upcoming.map((sub) => sub.id);
  const payments = await getLatestPaymentEvents({ subscriptionIds, fromDate: DateTime.now().minus({ days: 60 }).toISODate() });
  const latestPaidMap = new Map();
  payments.forEach((event) => {
    if (!latestPaidMap.has(event.subscription_id)) {
      latestPaidMap.set(event.subscription_id, event.event_date);
    }
  });

  const filtered = upcoming.filter((sub) => {
    const paidDate = latestPaidMap.get(sub.id);
    if (!paidDate) return true;
    const due = DateTime.fromISO(sub.next_due, { zone: 'utc' }).setZone(tz).startOf('day');
    const windowDays = sub.period === 'yearly' ? 366 : 45;
    const earliestPaid = due.minus({ days: windowDays });
    const eventDate = DateTime.fromISO(paidDate, { zone: tz }).startOf('day');
    return !(eventDate >= earliestPaid && eventDate <= due);
  });

  if (filtered.length === 0) {
    await ctx.reply('В ближайшие 7 дней списаний нет.');
    return;
  }

  const grouped = filtered.reduce((acc, sub) => {
    const dateKey = sub.next_due;
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(sub);
    return acc;
  }, {});

  const sections = Object.entries(grouped)
    .sort(([a], [b]) => {
      // Explicit date comparison to ensure chronological order
      const dateA = new Date(a);
      const dateB = new Date(b);
      return dateA - dateB;
    })
    .map(([date, subsForDay]) => {
      const header = `<b>${escapeHtml(formatShortDateWithWeekday(date, tz))}</b>`;
      const lines = subsForDay
        .map((sub) => {
          const emoji = sub.emoji || DEFAULT_EMOJI;
          return `${emoji} ${escapeHtml(sub.name)} — ${formatCurrency(sub.amount, sub.currency)}`;
        })
        .join('\n');
      return `${header}\n${lines}`;
    });

  const totalsByCurrency = upcoming.reduce((acc, sub) => {
    acc[sub.currency] = (acc[sub.currency] || 0) + sub.amount;
    return acc;
  }, {});

  const totalsLine = Object.entries(totalsByCurrency)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatCurrency(amount, currency))
    .join(', ');

  const message = `Списания в ближайшие 7 дней:\n\n${sections.join('\n\n')}\n\nИтого за 7 дней: ${totalsLine}`;

  await ctx.reply(message, { parse_mode: 'HTML' });
});

bot.command('reminders', async (ctx) => {
  const user = ctx.state.user;
  const offsets = parseReminderSelection(user?.default_reminders ?? DEFAULT_REMINDERS);
  const activeSet = new Set(offsets);
  const keyboard = buildRemindersKeyboard(activeSet);
  const message = renderRemindersMessage(user, activeSet);
  await ctx.reply(message, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
});

bot.command('timezone', async (ctx) => {
  await ctx.reply('Изменение часового пояса скоро добавим.');
});

bot.command('export', async (ctx) => {
  await ctx.reply('Экспорт CSV пока не реализован.');
});

bot.command('pause', async (ctx) => {
  await ctx.reply('Пауза подписки пока не реализована.');
});

if (ENABLE_REMINDER_SCHEDULER) {
  startReminderScheduler(bot)
    .then((handle) => {
      if (handle) {
        console.log('Reminder scheduler started');
      }
    })
    .catch((err) => console.error('Failed to start reminder scheduler', err));
} else {
  console.log('Reminder scheduler disabled (ENABLE_REMINDER_SCHEDULER=false).');
}

const launch = async () => {
  try {
    const me = await bot.api.getMe();
    console.log(`Запустился как @${me.username}`);

    await bot.api.setMyCommands(BOT_COMMANDS);

    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.start();

    console.log('Polling запущен');
  } catch (err) {
    console.error('Failed to launch bot', err);
    process.exit(1);
  }
};

launch();
