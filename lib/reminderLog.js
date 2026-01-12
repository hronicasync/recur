import { query } from '../db.js';

export const ensureSchema = async () => {
  await query(`
    create table if not exists reminder_log (
      key text primary key,
      sent_at timestamptz not null default now()
    )
  `);
};

export const claimReminder = async (key) => {
  const result = await query(
    `insert into reminder_log (key, sent_at)
     values ($1, now())
     on conflict (key) do nothing`,
    [key],
  );
  return result.rowCount > 0;
};

export const cleanOldReminders = async (daysToKeep = 30) => {
  const { rowCount } = await query(
    `DELETE FROM reminder_log
     WHERE sent_at < now() - interval '1 day' * $1`,
    [daysToKeep]
  );
  return rowCount;
};

export const getRemindersForUser = async (userId, limit = 10) => {
  const { rows } = await query(
    `SELECT key, sent_at
     FROM reminder_log
     WHERE key LIKE $1
     ORDER BY sent_at DESC
     LIMIT $2`,
    [`${userId}|%`, limit]
  );
  return rows;
};
