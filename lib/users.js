import { query } from '../db.js';

export const getUserById = async (userId) => {
  const { rows } = await query(
    'select user_id, tz, notify_hour, default_reminders from users where user_id = $1',
    [userId],
  );
  return rows[0] || null;
};

export const getAllUsers = async () => {
  const { rows } = await query(
    'select user_id, tz, notify_hour, default_reminders from users',
  );
  return rows;
};

export const ensureUser = async ({
  userId,
  tz,
  notifyHour,
  defaultReminders,
}) => {
  const existing = await getUserById(userId);
  if (existing) {
    return existing;
  }

  const reminders = Array.isArray(defaultReminders) ? defaultReminders : ['T-3', 'T-1', 'T0'];

  const { rows } = await query(
    `insert into users (user_id, tz, notify_hour, default_reminders)
     values ($1, $2, $3, $4)
     returning user_id, tz, notify_hour, default_reminders`,
    [userId, tz, notifyHour, JSON.stringify(reminders)],
  );

  return rows[0];
};

export const updateUser = async ({ userId, tz, notifyHour, defaultReminders }) => {
  const fields = [];
  const values = [];
  let idx = 1;

  if (tz) {
    fields.push(`tz = $${idx++}`);
    values.push(tz);
  }

  if (typeof notifyHour === 'number') {
    fields.push(`notify_hour = $${idx++}`);
    values.push(notifyHour);
  }

  if (defaultReminders !== undefined) {
    fields.push(`default_reminders = $${idx++}`);
    values.push(JSON.stringify(defaultReminders));
  }

  if (fields.length === 0) {
    return getUserById(userId);
  }

  values.push(userId);

  const { rows } = await query(
    `update users
       set ${fields.join(', ')}, updated_at = now()
     where user_id = $${idx}
     returning user_id, tz, notify_hour, default_reminders`,
    values,
  );

  return rows[0] || null;
};
