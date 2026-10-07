// Monthly performance per employee: how committed (attendance) and how active (what they recorded).
//
// Commitment (0-100): attendance rate on the days they were expected, minus 1 point per 10 minutes
// late (up to 30) and 1 point per 15 minutes of exits or leaving early (up to 20).
// Recording (0-100): share of attended days on which they recorded their daily numbers. Only for
// employees who have something to record.
// Score: 70% commitment + 30% recording, or commitment alone if they record nothing.
import { loadAttendance, summarize } from './attendance.js';
import { getSettings } from './settings.js';
import { monthBounds, addDays } from './time.js';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n);
export const prevMonth = (m) => addDays(`${m}-01`, -1).slice(0, 7);

export function performance(db, month, now = Date.now(), { withPrevious = true } = {}) {
  const { from, to } = monthBounds(month);
  const settings = getSettings(db);
  const att = summarize(loadAttendance(db, { from, to, now }));
  const users = db.prepare("SELECT id, name, perms FROM users WHERE role = 'employee' AND active = 1 ORDER BY id").all();
  const metricName = new Map(settings.metrics.map((m) => [m.key, m.name]));
  const prev = withPrevious ? new Map(performance(db, prevMonth(month), now, { withPrevious: false }).map((r) => [r.userId, r.score])) : new Map();

  const rows = users.map((u) => {
    const a = att.find((x) => x.userId === u.id) || { workDays: 0, presentDays: 0, absentDays: 0, excusedDays: 0, lateDays: 0, lateMinutes: 0, earlyMinutes: 0, exitMinutes: 0, presentMinutes: 0 };
    const perms = JSON.parse(u.perms || '[]');
    const expected = Math.max(0, a.workDays - a.excusedDays);
    const rate = expected ? (a.presentDays / expected) * 100 : 0;
    const commitment = expected ? round(clamp(rate - Math.min(30, a.lateMinutes / 10) - Math.min(20, (a.exitMinutes + a.earlyMinutes) / 15))) : null;

    const metrics = db.prepare(`SELECT key, SUM(value) total, COUNT(*) days FROM daily_metrics WHERE updated_by = ? AND date BETWEEN ? AND ? GROUP BY key`).all(u.id, from, to)
      .map((m) => ({ key: m.key, name: metricName.get(m.key) || m.key, total: m.total, days: m.days }));
    const recordDays = db.prepare(`SELECT COUNT(DISTINCT date) n FROM (
        SELECT date FROM daily_metrics WHERE updated_by = ? AND date BETWEEN ? AND ?
        UNION SELECT date FROM daily_ops WHERE updated_by = ? AND date BETWEEN ? AND ?
        UNION SELECT date FROM stock_moves WHERE created_by = ? AND date BETWEEN ? AND ?)`).get(u.id, from, to, u.id, from, to, u.id, from, to).n;
    const records = perms.some((p) => p === 'orders' || p.startsWith('m:'));
    const recording = records && a.presentDays ? round(clamp((recordDays / a.presentDays) * 100)) : null;
    const achievements = db.prepare("SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND kind = 'achievement' AND date BETWEEN ? AND ?").get(u.id, from, to).n;
    const requests = db.prepare('SELECT COUNT(*) n FROM requests WHERE user_id = ? AND date BETWEEN ? AND ?').get(u.id, from, to).n;

    const score = commitment === null ? null : recording === null ? commitment : round(commitment * 0.7 + recording * 0.3);
    const before = prev.get(u.id);
    return {
      userId: u.id, name: u.name, score, commitment, recording, attendanceRate: expected ? round(rate) : null,
      workDays: a.workDays, expectedDays: expected, presentDays: a.presentDays, absentDays: a.absentDays, lateDays: a.lateDays,
      lateMinutes: a.lateMinutes, exitMinutes: a.exitMinutes + a.earlyMinutes, presentMinutes: a.presentMinutes,
      recordDays, metrics, achievements, requests,
      previous: before ?? null, change: before == null || score == null ? null : score - before,
    };
  });
  // Best first; ties go to fewer late minutes.
  rows.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.lateMinutes - y.lateMinutes);
  let rank = 0;
  for (const r of rows) r.rank = r.score === null ? null : ++rank;
  return rows;
}

/** One short line on why someone scored what they did. */
export function scoreDetails(r) {
  const parts = [`حضور ${r.presentDays} من ${r.expectedDays} يوم`];
  parts.push(r.lateMinutes ? `تأخير ${r.lateMinutes} دقيقة` : 'بدون تأخير');
  if (r.recording !== null) parts.push(`سجّل أرقامه في ${r.recordDays} يوم`);
  if (r.achievements) parts.push(`${r.achievements} إنجاز`);
  return parts.join(' · ');
}
