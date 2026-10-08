// Local-day helpers. Every "date" in the system is a local YYYY-MM-DD string
// in the store's timezone; every timestamp is epoch milliseconds from the server clock.
import { config, DAY, MIN } from './config.js';

const off = () => config.tzOffsetMinutes * MIN;

/** Local calendar date (YYYY-MM-DD) of an epoch-ms timestamp. */
export function localDate(ts = Date.now()) {
  return new Date(ts + off()).toISOString().slice(0, 10);
}

/** Local clock time (HH:MM) of a timestamp. */
export function localTime(ts) {
  return new Date(ts + off()).toISOString().slice(11, 16);
}

/** Epoch ms for local date + "HH:MM". */
export function at(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.parse(`${date}T00:00:00Z`) - off() + (h * 60 + m) * MIN;
}

/** 0 = Sunday ... 5 = Friday, 6 = Saturday. */
export function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** dd/mm, for messages and notes. */
export const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;

export function isDate(s) {
  // the round trip rejects dates that don't exist (2026-02-31 would otherwise roll over to March)
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthBounds(month) {
  const from = `${month}-01`;
  const next = new Date(Date.parse(`${from}T00:00:00Z`));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(next.toISOString().slice(0, 10), -1) };
}
