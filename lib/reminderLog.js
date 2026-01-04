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
