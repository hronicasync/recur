import { query } from '../db.js';

export const logSubscriptionEvent = async ({ subscriptionId, date, status }) => {
  await query(
    `delete from subscription_events
      where subscription_id = $1 and event_date = $2 and status = $3`,
    [subscriptionId, date, status],
  );
  await query(
    `insert into subscription_events (subscription_id, event_date, status)
     values ($1, $2, $3)`,
    [subscriptionId, date, status],
  );
};

export const getLatestPaymentEvents = async ({ subscriptionIds, fromDate }) => {
  if (!subscriptionIds.length) return [];
  const { rows } = await query(
    `select subscription_id, event_date
       from subscription_events
      where subscription_id = any($1)
        and status = 'paid'
        and event_date >= $2
      order by subscription_id, event_date desc`,
    [subscriptionIds, fromDate],
  );
  return rows;
};

export const getPaidEventsForRange = async ({ userId, startDate, endDate }) => {
  const { rows } = await query(
    `select distinct on (e.subscription_id, e.event_date) e.subscription_id,
            e.event_date,
            s.name,
            s.amount,
            s.currency,
            s.period,
            s.emoji
       from subscription_events e
       join subscriptions s on s.id = e.subscription_id
      where e.status = 'paid'
        and s.user_id = $1
        and e.event_date between $2 and $3
      order by e.subscription_id, e.event_date desc`,
    [userId, startDate, endDate],
  );
  return rows;
};
