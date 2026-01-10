import 'dotenv/config';
import { DateTime } from 'luxon';
import { getAllUsers } from './lib/users.js';
import { listSubscriptionsForUser } from './lib/subscriptions.js';

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

const testReminders = async () => {
  console.log('=== REMINDER TEST ===\n');

  const utcNow = DateTime.utc();
  console.log(`UTC Now: ${utcNow.toISO()}\n`);

  let users;
  try {
    users = await getAllUsers();
    console.log(`Found ${users.length} users\n`);
  } catch (error) {
    console.error('Failed to load users', error);
    return;
  }

  for (const user of users) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`USER: ${user.user_id}`);
    console.log(`${'='.repeat(60)}`);

    const tz = user.tz || 'Europe/Moscow';
    const localNow = utcNow.setZone(tz);
    const dateKey = getLocalDateKey(localNow);

    console.log(`Timezone: ${tz}`);
    console.log(`Local Time: ${localNow.toISO()}`);
    console.log(`Notify Hour: ${user.notify_hour}`);
    console.log(`Weekday: ${localNow.weekday} (1=Mon, 7=Sun)`);
    console.log(`Current Hour: ${localNow.hour}`);
    console.log(`Current Minute: ${localNow.minute}`);
    console.log(`Date Key: ${dateKey}`);
    console.log(`Default Reminders: ${JSON.stringify(user.default_reminders)}`);

    let subscriptions;
    try {
      subscriptions = await listSubscriptionsForUser(user.user_id);
      console.log(`\nSubscriptions: ${subscriptions.length}`);
    } catch (error) {
      console.error('Failed to load subscriptions', error);
      continue;
    }

    // Check weekly digest
    const weeklyEligible = localNow.weekday === 1 && localNow.hour === user.notify_hour && localNow.minute >= 0 && localNow.minute < 2;
    if (weeklyEligible) {
      const key = buildKey(user.user_id, 'weekly', dateKey);
      console.log(`\n✅ WOULD SEND Weekly Digest: key=${key}`);
    } else {
      console.log(`\n❌ Weekly Digest: NO (weekday=${localNow.weekday}, hour=${localNow.hour}, minute=${localNow.minute})`);
    }

    for (const sub of subscriptions) {
      console.log(`\n  --- Subscription: ${sub.name} (id=${sub.id}) ---`);
      console.log(`  Next Due: ${sub.next_due}`);
      console.log(`  Reminders: ${JSON.stringify(sub.reminders)}`);

      const due = DateTime.fromISO(sub.next_due, { zone: 'utc' }).setZone(tz);
      if (!due.isValid) {
        console.log(`  ❌ Invalid due date`);
        continue;
      }

      const diffDays = Math.floor(due.startOf('day').diff(localNow.startOf('day'), 'days').days);
      console.log(`  Due Local: ${due.toISO()}`);
      console.log(`  Days Until Due: ${diffDays}`);

      const reminderOffsets = parseReminderOffsets(sub.reminders);
      console.log(`  Parsed Offsets: [${reminderOffsets.join(', ')}]`);

      const shouldSendPreNow = localNow.hour === user.notify_hour && localNow.minute >= 0 && localNow.minute < 2;

      // Check pre-reminders
      for (const offset of reminderOffsets) {
        if (offset <= 0) continue;
        if (diffDays === offset && shouldSendPreNow) {
          const key = buildKey(user.user_id, sub.id, `pre-${offset}`, dateKey);
          console.log(`  ✅ WOULD SEND Pre-reminder T-${offset}: key=${key}`);
        }
      }

      // Check morning reminder (T0)
      if (diffDays === 0 && localNow.hour === user.notify_hour && localNow.minute >= 0 && localNow.minute < 2) {
        const key = buildKey(user.user_id, sub.id, 'morning', dateKey);
        console.log(`  ✅ WOULD SEND Morning Reminder: key=${key}`);
      }

      // Check evening check
      if (diffDays === 0 && localNow.hour === EVENING_HOUR && localNow.minute >= 0 && localNow.minute < 2) {
        const key = buildKey(user.user_id, sub.id, 'evening', dateKey);
        console.log(`  ✅ WOULD SEND Evening Check: key=${key}`);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Test complete');
  process.exit(0);
};

testReminders().catch((err) => {
  console.error('Test failed', err);
  process.exit(1);
});
