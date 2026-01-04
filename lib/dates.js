import { DateTime } from 'luxon';

const monthDictionary = new Map([
  ['январь', 1], ['января', 1],
  ['февраль', 2], ['февраля', 2],
  ['март', 3], ['марта', 3],
  ['апрель', 4], ['апреля', 4],
  ['май', 5], ['мая', 5],
  ['июнь', 6], ['июня', 6],
  ['июль', 7], ['июля', 7],
  ['август', 8], ['августа', 8],
  ['сентябрь', 9], ['сентября', 9],
  ['октябрь', 10], ['октября', 10],
  ['ноябрь', 11], ['ноября', 11],
  ['декабрь', 12], ['декабря', 12],
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

const normalizeYear = (year) => {
  if (year >= 1000) return year;
  if (year >= 0 && year < 100) {
    return year + (year >= 50 ? 1900 : 2000);
  }
  return year;
};

export const parseUserDate = (input, tz = 'Europe/Moscow', options = {}) => {
  const { allowPast = false } = options;
  if (!input) return null;

  const cleaned = input.trim().replace(/,/g, '.');
  const now = DateTime.now().setZone(tz).startOf('day');

  const iso = DateTime.fromISO(cleaned, { zone: tz });
  if (iso.isValid) {
    return iso.startOf('day').toISODate();
  }

  const separatorMatch = cleaned.match(/^(\d{1,2})[\.\/-](\d{1,2})(?:[\.\/-](\d{2,4}))?$/);
  if (separatorMatch) {
    const day = Number.parseInt(separatorMatch[1], 10);
    const month = Number.parseInt(separatorMatch[2], 10);
    const year = separatorMatch[3] ? normalizeYear(Number.parseInt(separatorMatch[3], 10)) : now.year;

    const dt = DateTime.fromObject({ year, month, day }, { zone: tz });
    if (!dt.isValid) return null;
    if (!allowPast) {
      const candidate = dt.startOf('day');
      if (!separatorMatch[3] && candidate < now) {
        return candidate.plus({ year: 1 }).toISODate();
      }
      return candidate.toISODate();
    }
    return dt.startOf('day').toISODate();
  }

  const wordMatch = cleaned.match(/^(\d{1,2})\s+([A-Za-zА-Яа-яёЁ]+)(?:\s+(\d{4}|\d{2}))?$/);
  if (wordMatch) {
    const day = Number.parseInt(wordMatch[1], 10);
    const monthName = wordMatch[2].toLowerCase();
    const month = monthDictionary.get(monthName);
    if (!month) return null;
    const year = wordMatch[3] ? normalizeYear(Number.parseInt(wordMatch[3], 10)) : now.year;

    const dt = DateTime.fromObject({ year, month, day }, { zone: tz });
    if (!dt.isValid) return null;
    if (!allowPast) {
      const candidate = dt.startOf('day');
      if (!wordMatch[3] && candidate < now) {
        return candidate.plus({ year: 1 }).toISODate();
      }
      return candidate.toISODate();
    }
    return dt.startOf('day').toISODate();
  }

  return null;
};

export const calculateNextPeriodDate = ({ currentDate, period }) => {
  const dt = DateTime.fromISO(currentDate, { zone: 'utc' });
  if (!dt.isValid) return currentDate;

  if (period === 'monthly') {
    const next = dt.plus({ months: 1 });
    const endOfMonth = next.endOf('month');
    const targetDay = Math.min(dt.day, endOfMonth.day);
    return next.set({ day: targetDay }).toISODate();
  }

  if (period === 'yearly') {
    const next = dt.plus({ years: 1 });
    if (dt.month === 2 && dt.day === 29) {
      return next.set({ month: 2, day: DateTime.fromObject({ year: next.year, month: 2 }).endOf('month').day }).toISODate();
    }
    return next.toISODate();
  }

  return currentDate;
};

export const toDateTime = (value, zone = 'utc') => {
  if (!value) return null;

  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone });
  }

  if (typeof value === 'string') {
    let dt = DateTime.fromISO(value, { zone });
    if (dt.isValid) return dt;

    dt = DateTime.fromSQL(value, { zone });
    if (dt.isValid) return dt;

    const jsDate = new Date(value);
    if (!Number.isNaN(jsDate.getTime())) {
      return DateTime.fromJSDate(jsDate, { zone });
    }
  }

  return null;
};

export const formatDueWithPeriod = ({ date, period, tz }) => {
  const zone = tz || 'Europe/Moscow';
  const suffix = period === 'monthly' ? '(мес)' : '(год)';
  const dt = toDateTime(date, 'utc');

  if (!dt || !dt.isValid) {
    const raw = date instanceof Date ? date.toISOString().slice(0, 10) : String(date ?? '—');
    return `${raw} ${suffix}`;
  }

  const humanDate = dt.setZone(zone).setLocale('ru').toFormat('d LLL');
  return `${humanDate} ${suffix}`;
};

export const startOfToday = (tz) => DateTime.now().setZone(tz || 'Europe/Moscow').startOf('day').toISODate();

export const isDateInPast = (isoDate, tz = 'Europe/Moscow') => {
  const zone = tz || 'Europe/Moscow';
  const dt = toDateTime(isoDate, zone);
  if (!dt || !dt.isValid) return false;
  const today = DateTime.now().setZone(zone).startOf('day');
  return dt.startOf('day') < today;
};

export const formatShortDateWithWeekday = (date, tz = 'Europe/Moscow') => {
  const dt = toDateTime(date, 'utc');
  if (!dt || !dt.isValid) {
    return String(date ?? '—');
  }
  return dt.setZone(tz).setLocale('ru').toFormat('d LLL, ccc').replace(/\./g, '');
};

export const formatDateWithWeekday = (date, tz = 'Europe/Moscow') => {
  const dt = toDateTime(date, 'utc');
  if (!dt || !dt.isValid) {
    return String(date ?? '—');
  }
  return dt.setZone(tz).setLocale('ru').toFormat('d LLL, ccc').replace(/\./g, '');
};

export const formatDateWithYear = (date, tz = 'Europe/Moscow') => {
  const dt = toDateTime(date, 'utc');
  if (!dt || !dt.isValid) {
    return String(date ?? '—');
  }
  return dt.setZone(tz).setLocale('ru').toFormat('dd.MM.yyyy');
};

export const addDays = (date, days) => {
  const dt = DateTime.fromISO(date, { zone: 'utc' });
  if (!dt.isValid) {
    return date;
  }
  return dt.plus({ days }).toISODate();
};

export const formatMonthTitle = (date, tz = 'Europe/Moscow') => {
  const dt = toDateTime(date, 'utc');
  const target = (dt && dt.isValid ? dt : DateTime.fromISO(date ?? DateTime.now().toISODate(), { zone: tz }))
    .setZone(tz)
    .setLocale('ru');
  const formatted = target.toFormat('LLLL, yyyy');
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
};

export const formatDayMonthWeekday = (date, tz = 'Europe/Moscow') => {
  const dt = toDateTime(date, 'utc');
  if (!dt || !dt.isValid) {
    return String(date ?? '—');
  }
  return dt.setZone(tz).setLocale('ru').toFormat('d LLL, ccc');
};
