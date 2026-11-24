// Payroll period of a month. By default a payroll month is the calendar month. With a start day
// set (settings.payroll_start_day, e.g. 27), the payroll of a month runs from that day of the
// previous month to the day before it in this month: December = 27/11 → 26/12, closed from 27/12.
//
// A closed month keeps the period it was closed with (months closed before this setting existed
// were calendar months). An open month next to a closed one starts the day after it ends and ends
// the day before it starts, so changing the start day never counts a day twice or drops one.
import { getSettings } from './settings.js';
import { addDays, monthBounds } from './time.js';

const pad = (n) => String(n).padStart(2, '0');

/** "2026-12" shifted by n months. */
export const shiftMonth = (month, n) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);

export const payrollStartDay = (db) => {
  const d = Math.round(Number(getSettings(db).payroll_start_day));
  return d >= 1 && d <= 28 ? d : 1;
};

/** The period by the setting alone, ignoring closed months. */
export function nominalPeriod(month, startDay = 1) {
  if (startDay <= 1) return monthBounds(month);
  return { from: `${shiftMonth(month, -1)}-${pad(startDay)}`, to: `${month}-${pad(startDay - 1)}` };
}

function closedPeriod(db, month) {
  const c = db.prepare('SELECT period_from, period_to FROM payroll_closes WHERE month = ?').get(month);
  if (!c) return null;
  return c.period_from && c.period_to ? { from: c.period_from, to: c.period_to } : monthBounds(month);
}

/** { from, to } (inclusive local dates) of a payroll month. */
export function payPeriod(db, month) {
  const own = closedPeriod(db, month);
  if (own) return own;
  const p = nominalPeriod(month, payrollStartDay(db));
  const prev = closedPeriod(db, shiftMonth(month, -1));
  const next = closedPeriod(db, shiftMonth(month, 1));
  return { from: prev ? addDays(prev.to, 1) : p.from, to: next ? addDays(next.from, -1) : p.to };
}

/** The payroll month a date belongs to. */
export function payMonthOf(db, date) {
  const m = String(date).slice(0, 7);
  for (const c of [m, shiftMonth(m, 1), shiftMonth(m, -1)]) {
    const p = payPeriod(db, c);
    if (date >= p.from && date <= p.to) return c;
  }
  return m;
}
