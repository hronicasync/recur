import { DateTime } from 'luxon';
import { toDateTime } from './dates.js';

const currencySymbols = {
  RUB: '₽',
  EUR: '€',
  USD: '$',
  KZT: '₸',
  BYN: 'Br',
};

export const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const pluralizeDays = (value) => {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня';
  return 'дней';
};

export const normalizeAmount = (value) => {
  if (typeof value !== 'string') {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  const normalized = value.replace(/\s+/g, '').replace(',', '.');
  const number = Number.parseFloat(normalized);

  if (Number.isNaN(number) || number <= 0) {
    return null;
  }

  return Number(number.toFixed(2));
};

export const formatCurrency = (amount, currency) => {
  const symbol = currencySymbols[currency] || currency;
  const formatter = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });

  return formatter
    .format(amount)
    .replace(/[\s\xa0]/g, ' ')
    .replace(currency, symbol)
    .replace(/ +/g, ' ')
    .trim();
};

export const formatDate = ({ date, tz, withWeekday = false }) => {
  const zone = tz || 'Europe/Moscow';
  const dt = toDateTime(date, 'utc');

  if (!dt || !dt.isValid) {
    return String(date ?? '—');
  }

  const target = dt.setZone(zone).setLocale('ru');
  const pattern = withWeekday ? 'ccc d LLL' : 'd LLL';
  return target.toFormat(pattern);
};

export const calculateTotals = (subscriptions = []) => {
  const totals = {};

  subscriptions.forEach((sub) => {
    const currency = sub.currency;
    if (!totals[currency]) {
      totals[currency] = { monthly: 0, yearly: 0 };
    }

    if (sub.period === 'monthly') {
      totals[currency].monthly += sub.amount;
      totals[currency].yearly += sub.amount * 12;
    } else if (sub.period === 'yearly') {
      totals[currency].yearly += sub.amount;
    }
  });

  return totals;
};
