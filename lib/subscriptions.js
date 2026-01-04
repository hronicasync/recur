import { query } from '../db.js';

export const findSubscriptionByNameAndDate = async ({ userId, name, nextDue }) => {
  const { rows } = await query(
    `select id, user_id, name, amount, currency, period, next_due, reminders
       from subscriptions
      where user_id = $1 and lower(name) = lower($2) and next_due = $3`,
    [userId, name, nextDue],
  );
  return rows[0] || null;
};

export const createSubscription = async ({
  userId,
  name,
  amount,
  currency,
  period,
  nextDue,
  reminders,
  notes,
}) => {
  const { rows } = await query(
    `insert into subscriptions (user_id, name, amount, currency, period, next_due, reminders, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, user_id, name, amount, currency, period, next_due, reminders, notes`,
    [userId, name, amount, currency, period, nextDue, JSON.stringify(reminders), notes || null],
  );

  return rows[0];
};

export const updateSubscription = async (id, updates = {}) => {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (key === 'reminders') {
      fields.push(`reminders = $${idx}`);
      values.push(JSON.stringify(value));
    } else {
      fields.push(`${key} = $${idx}`);
      values.push(value);
    }
    idx += 1;
  }

  if (fields.length === 0) {
    const { rows } = await query(
      'select id, user_id, name, amount, currency, period, next_due, reminders, notes from subscriptions where id = $1',
      [id],
    );
    return rows[0] || null;
  }

  values.push(id);

  const { rows } = await query(
    `update subscriptions
        set ${fields.join(', ')}, updated_at = now()
      where id = $${idx}
      returning id, user_id, name, amount, currency, period, next_due, reminders, notes`,
    values,
  );

  return rows[0] || null;
};

export const deleteSubscription = async ({ id, userId }) => {
  const { rowCount } = await query(
    'delete from subscriptions where id = $1 and user_id = $2',
    [id, userId],
  );
  return rowCount > 0;
};

export const listSubscriptionsForUser = async (userId) => {
  const { rows } = await query(
    `select id, user_id, name, amount, currency, period, next_due, reminders
       from subscriptions
      where user_id = $1
      order by next_due asc, lower(name) asc`,
    [userId],
  );
  return rows;
};

export const getSubscriptionById = async (id) => {
  const { rows } = await query(
    `select id, user_id, name, amount, currency, period, next_due, reminders
       from subscriptions
      where id = $1`,
    [id],
  );
  return rows[0] || null;
};

export const getUpcomingSubscriptions = async ({ userId, days = 7 }) => {
  const { rows } = await query(
    `select id, user_id, name, amount, currency, period, next_due, reminders
       from subscriptions
      where user_id = $1
        and next_due between current_date and current_date + $2::interval
      order by next_due asc, lower(name) asc`,
    [userId, `${days} days`],
  );
  return rows;
};

export const shiftNextDue = async ({ id, userId, nextDue }) => {
  const { rows } = await query(
    `update subscriptions
        set next_due = $1,
            updated_at = now()
      where id = $2 and user_id = $3
      returning id, user_id, name, amount, currency, period, next_due, reminders`,
    [nextDue, id, userId],
  );
  return rows[0] || null;
};

export const setRemindersForUser = async ({ userId, reminders }) => {
  await query(
    `update subscriptions
        set reminders = $1::jsonb,
            updated_at = now()
      where user_id = $2`,
    [JSON.stringify(reminders), userId],
  );
};

export const getSubscriptionsDueInRange = async ({ userId, startDate, endDate }) => {
  const { rows } = await query(
    `select id, user_id, name, amount, currency, period, next_due, reminders
       from subscriptions
      where user_id = $1
        and next_due between $2 and $3
      order by next_due asc, lower(name) asc`,
    [userId, startDate, endDate],
  );
  return rows;
};
