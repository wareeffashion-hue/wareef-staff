// Turns raw punches into a day's attendance: lateness, early leave, exits during
// work, absence, overtime and a suggested deduction. Pure functions + one loader.
import { MIN } from './config.js';
import { at, localDate, weekday, dateRange } from './time.js';
import { getSettings } from './settings.js';

const round2 = (n) => Math.round(n * 100) / 100;
const mins = (ms) => Math.max(0, Math.round(ms / MIN));

/** Scheduled periods for one employee on one date ([] = not a working day). */
export function periodsFor(user, date, schedule, holiday = false) {
  if (holiday) return [];
  const wd = weekday(date);
  if (user.day_off !== null && user.day_off !== undefined && Number(user.day_off) === wd) return [];
  const assigned = user.periods ? (typeof user.periods === 'string' ? JSON.parse(user.periods) : user.periods) : null;
  return (schedule.days[wd] || []).filter((p) => !assigned || assigned.includes(p.id));
}

/**
 * @param {object} o
 * @param {string} o.date            local YYYY-MM-DD
 * @param {Array}  o.punches         [{ts, type, note}] for that user and date, any order
 * @param {Array}  o.periods         [{id, name, start, end}] scheduled for that user that day
 * @param {string|null} o.excuse     approved excuse kind, if any
 * @param {number} o.grace           minutes of lateness forgiven
 * @param {number} o.maxExit         minutes a temporary exit may last before it's flagged
 * @param {number} o.salary          monthly salary, for the suggested deduction
 * @param {number} o.now             epoch ms
 */
export function computeDay({ date, punches, periods, excuse = null, grace = 0, maxExit = 30, salary = 0, now = Date.now() }) {
  const sorted = [...punches].sort((a, b) => a.ts - b.ts);
  const flags = new Set();
  const intervals = []; // [start, end] while present
  const exits = [];     // [start, end, note] temporary exits
  let state = 'out';
  let cur = null;
  let leave = null;

  for (const p of sorted) {
    if (p.type === 'in' || p.type === 'back') {
      if (state === 'leave') { exits.push([leave.ts, p.ts, leave.note]); state = 'in'; cur = p.ts; }
      else if (state === 'out') { state = 'in'; cur = p.ts; }
      else flags.add('duplicate_in');
    } else if (p.type === 'leave') {
      if (state === 'in') { intervals.push([cur, p.ts]); state = 'leave'; leave = p; }
    } else if (p.type === 'out') {
      if (state === 'in') { intervals.push([cur, p.ts]); state = 'out'; }
      else if (state === 'leave') { state = 'out'; flags.add('no_return'); }
    }
  }

  const lastEnd = periods.length ? at(date, periods[periods.length - 1].end) : null;
  // Still "inside" only while the day is running; two hours after the last period a missing checkout is flagged.
  const isToday = date === localDate(now) && (lastEnd === null || now <= lastEnd + 120 * MIN);
  let liveState = state;
  if (state === 'in') {
    if (isToday) intervals.push([cur, Math.max(cur, now)]);
    else { intervals.push([cur, Math.max(cur, lastEnd ?? cur)]); flags.add('missing_out'); liveState = 'out'; }
  } else if (state === 'leave') {
    if (isToday) exits.push([leave.ts, Math.max(leave.ts, now), leave.note]);
    else { flags.add('no_return'); liveState = 'out'; }
  }
  for (const [s, e] of exits) if (e - s > maxExit * MIN) flags.add('long_exit');

  const graceMs = grace * MIN;
  const out = periods.map((p) => {
    const s = at(date, p.start);
    const e = at(date, p.end);
    const row = { id: p.id, name: p.name, start: p.start, end: p.end, minutes: mins(e - s), firstIn: null, lastOut: null, late: 0, early: 0, exit: 0, present: 0, absent: false, state: 'done' };
    if (s > now) { row.state = 'upcoming'; return row; }
    const until = Math.min(e, now);
    const ov = intervals.map(([a, b]) => [Math.max(a, s), Math.min(b, until)]).filter(([a, b]) => b > a);
    const present = ov.reduce((t, [a, b]) => t + (b - a), 0);
    row.present = mins(present);
    if (e > now) row.state = 'running';
    if (!ov.length) {
      if (e <= now) { row.absent = true; return row; }
      // Period is running and the employee hasn't arrived yet.
      row.state = 'not_arrived';
      if (now - s > graceMs) row.late = mins(now - s);
      return row;
    }
    const lateMs = ov[0][0] - s;
    const earlyMs = e <= now ? Math.max(0, e - ov[ov.length - 1][1]) : 0;
    row.firstIn = ov[0][0];
    row.lastOut = e <= now ? ov[ov.length - 1][1] : null;
    row.late = lateMs > graceMs ? mins(lateMs) : 0;
    row.early = mins(earlyMs);
    row.exit = mins(until - s - present - lateMs - earlyMs);
    return row;
  });

  const scheduledMinutes = out.reduce((t, p) => t + p.minutes, 0);
  const total = mins(intervals.reduce((t, [a, b]) => t + (b - a), 0));
  const sum = (k) => out.reduce((t, p) => t + p[k], 0);
  const absentMinutes = out.filter((p) => p.absent).reduce((t, p) => t + p.minutes, 0);
  const res = {
    date,
    periods: out,
    scheduledMinutes,
    presentMinutes: total,
    overtimeMinutes: overtime(intervals, periods, date),
    lateMinutes: sum('late'),
    earlyMinutes: sum('early'),
    exitMinutes: sum('exit'),
    absentMinutes,
    absentPeriods: out.filter((p) => p.absent).length,
    firstIn: intervals.length ? intervals[0][0] : null,
    lastOut: state === 'out' && intervals.length ? intervals[intervals.length - 1][1] : null,
    exits: exits.map(([s, e, note]) => ({ start: s, end: e, minutes: mins(e - s), note: note || '' })),
    liveState,
    flags: [...flags],
    excuse,
    status: 'present',
    suggested: 0,
  };

  if (excuse) {
    res.status = 'excused';
    res.lateMinutes = res.earlyMinutes = res.exitMinutes = res.absentMinutes = res.absentPeriods = 0;
    return res;
  }
  if (!periods.length) { res.status = total > 0 ? 'off_worked' : 'off'; return res; }
  const started = out.filter((p) => p.state !== 'upcoming');
  if (!started.length) res.status = total > 0 ? 'present' : 'upcoming';
  else if (res.absentPeriods === periods.length) res.status = 'absent';
  else if (res.absentPeriods > 0) res.status = 'partial';
  else if (started.every((p) => p.state === 'not_arrived')) res.status = 'not_arrived';
  else if (res.lateMinutes > 0) res.status = 'late';

  if (salary > 0 && scheduledMinutes > 0) {
    const perMinute = salary / 30 / scheduledMinutes;
    const live = out.filter((p) => p.state === 'not_arrived').reduce((t, p) => t + p.late, 0);
    res.suggested = round2(perMinute * (res.lateMinutes - live + res.earlyMinutes + res.exitMinutes + res.absentMinutes));
  }
  return res;
}

/** Presence before the first period or after the last one (breaks between periods don't count). */
function overtime(intervals, periods, date) {
  const total = intervals.reduce((t, [a, b]) => t + (b - a), 0);
  if (!periods.length) return mins(total);
  const s = at(date, periods[0].start);
  const e = at(date, periods[periods.length - 1].end);
  const within = intervals.reduce((t, [a, b]) => t + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
  return mins(total - within);
}

/** Attendance for every (employee, date) in a range. */
export function loadAttendance(db, { from, to, userId = null, now = Date.now() }) {
  const settings = getSettings(db);
  const users = db.prepare(`SELECT id, name, username, salary, periods, day_off, created_at FROM users
                            WHERE role = 'employee' AND active = 1 ${userId ? 'AND id = ?' : ''} ORDER BY id`)
    .all(...(userId ? [userId] : []));
  const today = localDate(now);
  const punches = db.prepare(`SELECT user_id, date, ts, type, note FROM punches WHERE voided = 0 AND date BETWEEN ? AND ?`).all(from, to);
  const excuses = db.prepare('SELECT user_id, date, kind FROM excuses WHERE date BETWEEN ? AND ?').all(from, to);
  const byKey = new Map();
  for (const p of punches) {
    const k = `${p.user_id}|${p.date}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }
  const holidays = new Set(excuses.filter((e) => e.user_id === null).map((e) => e.date));
  const excuseOf = new Map(excuses.filter((e) => e.user_id !== null).map((e) => [`${e.user_id}|${e.date}`, e.kind]));

  const rows = [];
  for (const u of users) {
    const since = localDate(u.created_at);
    for (const date of dateRange(from, to)) {
      if (date > today) continue;
      const day = computeDay({
        date,
        punches: byKey.get(`${u.id}|${date}`) || [],
        periods: date < since ? [] : periodsFor(u, date, settings.schedule, holidays.has(date)),
        excuse: excuseOf.get(`${u.id}|${date}`) || null,
        grace: settings.grace_minutes,
        maxExit: settings.max_exit_minutes,
        salary: u.salary,
        now,
      });
      if (holidays.has(date)) day.status = day.presentMinutes ? 'off_worked' : 'holiday';
      rows.push({ userId: u.id, name: u.name, ...day });
    }
  }
  return rows;
}

/** Per-employee totals over a list of day rows. */
export function summarize(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.userId)) map.set(r.userId, { userId: r.userId, name: r.name, workDays: 0, presentDays: 0, absentDays: 0, partialDays: 0, lateDays: 0, excusedDays: 0, lateMinutes: 0, earlyMinutes: 0, exitMinutes: 0, overtimeMinutes: 0, presentMinutes: 0, suggested: 0, flags: 0 });
    const s = map.get(r.userId);
    if (r.scheduledMinutes > 0 && r.status !== 'upcoming') s.workDays++;
    if (['present', 'late', 'partial', 'off_worked'].includes(r.status)) s.presentDays++;
    if (r.status === 'absent') s.absentDays++;
    if (r.status === 'partial') s.partialDays++;
    if (r.status === 'excused') s.excusedDays++;
    if (r.lateMinutes > 0) s.lateDays++;
    s.lateMinutes += r.lateMinutes;
    s.earlyMinutes += r.earlyMinutes;
    s.exitMinutes += r.exitMinutes;
    s.overtimeMinutes += r.overtimeMinutes;
    s.presentMinutes += r.presentMinutes;
    s.suggested = round2(s.suggested + r.suggested);
    s.flags += r.flags.length;
  }
  return [...map.values()];
}
