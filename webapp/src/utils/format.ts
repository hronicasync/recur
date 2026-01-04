const currencyFormatter = (currency: string) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  });

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  weekday: 'short',
});

function parseISODate(date: string) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

export const format = {
  currency(amount: number, currency: string) {
    return currencyFormatter(currency).format(amount).replace(/\s/g, ' ');
  },
  date(date: string) {
    return dateFormatter.format(parseISODate(date));
  },
};
