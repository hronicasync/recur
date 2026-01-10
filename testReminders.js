import 'dotenv/config';
import { Bot } from 'grammy';
import { DateTime } from 'luxon';
import { getAllUsers } from './lib/users.js';
import { listSubscriptionsForUser } from './lib/subscriptions.js';
import { formatCurrency, escapeHtml, pluralizeDays } from './lib/format.js';
import { formatShortDateWithWeekday } from './lib/dates.js';

const EVENING_HOUR = 20;

const buildKey = (...parts) => parts.join('|');

const parseReminderOffsets = (reminders) => {
  let reminderArray;

  if (Array.isArray(reminders)) {
    reminderArray = reminders;
  } else if (typeof reminders === 'string') {
    try {
      reminderArray = JSON.parse(reminders);
    } catch (err) {
      return [];
    }
  } else {
    return [];
  }

  if (!Array.isArray(reminderArray)) return [];

  return reminderArray
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

const printHelp = () => {
  console.log(`
=== Test Reminder Script ===

Usage: node testReminders.js [options]

Options:
  --help                Show this help
  --dry-run             Default mode: show what would be sent without sending
  --send                Actually send reminders to Telegram
  --time HH:MM          Simulate specific local time (e.g., --time 10:00)
  --user USER_ID        Test only for specific user ID
  --force               Skip time checks, trigger all reminders for today

Examples:
  node testReminders.js
    → Dry-run for current time

  node testReminders.js --time 10:00
    → Dry-run simulating 10:00 AM local time

  node testReminders.js --send --force --user 123456
    → Send all reminders for user 123456 ignoring time

  node testReminders.js --send --time 20:00
    → Send evening reminders as if it's 8 PM now
`);
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    dryRun: true,
    send: false,
    time: null,
    userId: null,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      options.send = false;
    } else if (arg === '--send') {
      options.send = true;
      options.dryRun = false;
    } else if (arg === '--time' && args[i + 1]) {
      options.time = args[++i];
    } else if (arg === '--user' && args[i + 1]) {
      options.userId = args[++i];
    } else if (arg === '--force') {
      options.force = true;
    }
  }

  return options;
};

const createSimulatedTime = (timeStr, tz) => {
  const utcNow = DateTime.utc();
  const localNow = utcNow.setZone(tz);

  if (!timeStr) return { utcNow, localNow };

  const [hours, minutes] = timeStr.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) {
    console.error(`Invalid time format: ${timeStr}. Use HH:MM`);
    process.exit(1);
  }

  const simulatedLocal = localNow.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
  const simulatedUtc = simulatedLocal.toUTC();

  return { utcNow: simulatedUtc, localNow: simulatedLocal };
};

const testReminders = async () => {
  const options = parseArgs();

  console.log('=== REMINDER TEST ===\n');
  console.log(`Mode: ${options.send ? '🔴 SEND (real)' : '🟢 DRY-RUN (no sending)'}`);
  console.log(`Simulated time: ${options.time || 'current'}`);
  console.log(`Force mode: ${options.force ? 'YES' : 'NO'}`);
  console.log(`User filter: ${options.userId || 'all'}\n`);

  let bot = null;
  if (options.send) {
    if (!process.env.BOT_TOKEN) {
      console.error('❌ BOT_TOKEN not found in environment');
      process.exit(1);
    }
    bot = new Bot(process.env.BOT_TOKEN);
    console.log('✅ Bot initialized\n');
  }

  let users;
  try {
    users = await getAllUsers();
    if (options.userId) {
      users = users.filter((u) => String(u.user_id) === String(options.userId));
    }
    console.log(`Found ${users.length} users\n`);
  } catch (error) {
    console.error('Failed to load users', error);
    process.exit(1);
  }

  const results = {
    weeklyDigest: [],
    preReminders: [],
    morningReminders: [],
    eveningChecks: [],
  };

  for (const user of users) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`USER: ${user.user_id}`);
    console.log(`${'='.repeat(60)}`);

    const tz = user.tz || 'Europe/Moscow';
    const { utcNow, localNow } = createSimulatedTime(options.time, tz);
    const dateKey = getLocalDateKey(localNow);

    console.log(`Timezone: ${tz}`);
    console.log(`Local Time: ${localNow.toFormat('yyyy-MM-dd HH:mm:ss')}`);
    console.log(`UTC Time: ${utcNow.toISO()}`);
    console.log(`Notify Hour: ${user.notify_hour}`);
    console.log(`Weekday: ${localNow.weekday} (1=Mon, 7=Sun)`);
    console.log(`Date Key: ${dateKey}`);

    let subscriptions;
    try {
      subscriptions = await listSubscriptionsForUser(user.user_id);
      console.log(`Subscriptions: ${subscriptions.length}`);
    } catch (error) {
      console.error('Failed to load subscriptions', error);
      continue;
    }

    // Check weekly digest
    const weeklyTimeMatch = localNow.hour === user.notify_hour && localNow.minute >= 0 && localNow.minute < 2;
    const weeklyEligible = options.force || (localNow.weekday === 1 && weeklyTimeMatch);

    if (weeklyEligible && subscriptions.length > 0) {
      const key = buildKey(user.user_id, 'weekly', dateKey);
      console.log(`\n✅ WEEKLY DIGEST: key=${key}`);

      const upcoming = subscriptions
        .filter((sub) => {
          const due = sub.next_due instanceof Date
            ? DateTime.fromJSDate(sub.next_due, { zone: 'utc' }).setZone(tz)
            : DateTime.fromISO(sub.next_due, { zone: 'utc' }).setZone(tz);
          const diff = Math.floor(due.startOf('day').diff(localNow.startOf('day'), 'days').days);
          return diff >= 0 && diff <= 6;
        })
        .sort((a, b) => (a.next_due < b.next_due ? -1 : 1));

      if (upcoming.length > 0) {
        const lines = upcoming.map(
          (sub) => `  ${formatShortDateWithWeekday(sub.next_due, tz)} — ${sub.name} ${formatCurrency(sub.amount, sub.currency)}`
        );
        console.log(`  Upcoming this week (${upcoming.length}):`);
        lines.forEach((l) => console.log(l));

        if (options.send && bot) {
          try {
            const message = ['На этой неделе:', '', ...lines.map((l) => l.trim()), ''].join('\n');
            await bot.api.sendMessage(user.user_id, `🧪 [TEST] ${message}`);
            console.log(`  📤 SENT!`);
            results.weeklyDigest.push({ userId: user.user_id, status: 'sent' });
          } catch (err) {
            console.error(`  ❌ Failed to send:`, err.message);
            results.weeklyDigest.push({ userId: user.user_id, status: 'failed', error: err.message });
          }
        } else {
          results.weeklyDigest.push({ userId: user.user_id, status: 'would_send' });
        }
      }
    } else {
      console.log(`\n❌ Weekly Digest: NO (weekday=${localNow.weekday}, hour=${localNow.hour}, minute=${localNow.minute})`);
    }

    for (const sub of subscriptions) {
      console.log(`\n  --- ${sub.emoji || '▫️'} ${sub.name} (id=${sub.id}) ---`);
      console.log(`  Next Due: ${sub.next_due}`);
      console.log(`  Reminders: ${JSON.stringify(sub.reminders)}`);

      // next_due может быть Date объектом или строкой
      const due = sub.next_due instanceof Date
        ? DateTime.fromJSDate(sub.next_due, { zone: 'utc' }).setZone(tz)
        : DateTime.fromISO(sub.next_due, { zone: 'utc' }).setZone(tz);
      if (!due.isValid) {
        console.log(`  ❌ Invalid due date: ${sub.next_due}`);
        continue;
      }

      const diffDays = Math.floor(due.startOf('day').diff(localNow.startOf('day'), 'days').days);
      console.log(`  Due Local: ${due.toFormat('yyyy-MM-dd HH:mm')}`);
      console.log(`  Days Until Due: ${diffDays}`);

      const reminderOffsets = parseReminderOffsets(sub.reminders);
      console.log(`  Parsed Offsets: [${reminderOffsets.join(', ')}]`);

      const isNotifyHour = localNow.hour === user.notify_hour && localNow.minute >= 0 && localNow.minute < 2;

      // Pre-reminders
      for (const offset of reminderOffsets) {
        if (offset <= 0) continue;
        const shouldSendPre = options.force || (diffDays === offset && isNotifyHour);

        if (shouldSendPre) {
          const key = buildKey(user.user_id, sub.id, `pre-${offset}`, dateKey);
          console.log(`  ✅ PRE-REMINDER T-${offset}: key=${key}`);

          if (options.send && bot) {
            try {
              const weekday = formatShortDateWithWeekday(sub.next_due, tz);
              const message = `🧪 [TEST] Через ${offset} ${pluralizeDays(offset)} спишется: ${escapeHtml(sub.name)} — ${formatCurrency(sub.amount, sub.currency)} (${weekday}).`;
              await bot.api.sendMessage(user.user_id, message, { parse_mode: 'HTML' });
              console.log(`  📤 SENT!`);
              results.preReminders.push({ userId: user.user_id, subId: sub.id, offset, status: 'sent' });
            } catch (err) {
              console.error(`  ❌ Failed to send:`, err.message);
              results.preReminders.push({ userId: user.user_id, subId: sub.id, offset, status: 'failed', error: err.message });
            }
          } else {
            results.preReminders.push({ userId: user.user_id, subId: sub.id, offset, status: 'would_send' });
          }
        }
      }

      // Morning reminder (T0)
      const shouldSendMorning = options.force || (diffDays === 0 && isNotifyHour);
      if (shouldSendMorning) {
        const key = buildKey(user.user_id, sub.id, 'morning', dateKey);
        console.log(`  ✅ MORNING REMINDER: key=${key}`);

        if (options.send && bot) {
          try {
            const weekday = formatShortDateWithWeekday(sub.next_due, tz);
            const message = `🧪 [TEST] Сегодня спишется: ${escapeHtml(sub.name)} — ${formatCurrency(sub.amount, sub.currency)} (${weekday}).`;
            await bot.api.sendMessage(user.user_id, message, { parse_mode: 'HTML' });
            console.log(`  📤 SENT!`);
            results.morningReminders.push({ userId: user.user_id, subId: sub.id, status: 'sent' });
          } catch (err) {
            console.error(`  ❌ Failed to send:`, err.message);
            results.morningReminders.push({ userId: user.user_id, subId: sub.id, status: 'failed', error: err.message });
          }
        } else {
          results.morningReminders.push({ userId: user.user_id, subId: sub.id, status: 'would_send' });
        }
      }

      // Evening check
      const shouldSendEvening = options.force || (diffDays === 0 && localNow.hour === EVENING_HOUR && localNow.minute >= 0 && localNow.minute < 2);
      if (shouldSendEvening) {
        const key = buildKey(user.user_id, sub.id, 'evening', dateKey);
        console.log(`  ✅ EVENING CHECK: key=${key}`);

        if (options.send && bot) {
          try {
            const message = `🧪 [TEST] ${escapeHtml(sub.name)} — ${formatCurrency(sub.amount, sub.currency)} сегодня. Оплата прошла?`;
            await bot.api.sendMessage(user.user_id, message, { parse_mode: 'HTML' });
            console.log(`  📤 SENT!`);
            results.eveningChecks.push({ userId: user.user_id, subId: sub.id, status: 'sent' });
          } catch (err) {
            console.error(`  ❌ Failed to send:`, err.message);
            results.eveningChecks.push({ userId: user.user_id, subId: sub.id, status: 'failed', error: err.message });
          }
        } else {
          results.eveningChecks.push({ userId: user.user_id, subId: sub.id, status: 'would_send' });
        }
      }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Weekly Digests: ${results.weeklyDigest.length}`);
  console.log(`Pre-Reminders: ${results.preReminders.length}`);
  console.log(`Morning Reminders: ${results.morningReminders.length}`);
  console.log(`Evening Checks: ${results.eveningChecks.length}`);

  const total = results.weeklyDigest.length + results.preReminders.length + results.morningReminders.length + results.eveningChecks.length;
  console.log(`\nTotal: ${total} reminder(s)`);

  if (options.send) {
    const sent = [...results.weeklyDigest, ...results.preReminders, ...results.morningReminders, ...results.eveningChecks].filter(
      (r) => r.status === 'sent'
    ).length;
    const failed = [...results.weeklyDigest, ...results.preReminders, ...results.morningReminders, ...results.eveningChecks].filter(
      (r) => r.status === 'failed'
    ).length;
    console.log(`Sent: ${sent}, Failed: ${failed}`);
  }

  console.log('\nTest complete');
  process.exit(0);
};

testReminders().catch((err) => {
  console.error('Test failed', err);
  process.exit(1);
});
