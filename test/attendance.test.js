import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDay, periodsFor } from '../src/attendance.js';
import { DEFAULTS } from '../src/settings.js';
import { at } from '../src/time.js';

const SAT = '2026-10-03'; // Saturday
const FRI = '2026-10-02'; // Friday
const periods = DEFAULTS.schedule.days[6];
const p = (time, type, note = '') => ({ ts: at(SAT, time), type, note });
const evening = at(SAT, '23:00');

test('weekly schedule: two periods Sat–Thu, one on Friday', () => {
  assert.deepEqual(periodsFor({}, SAT, DEFAULTS.schedule).map((x) => `${x.start}-${x.end}`), ['07:00-12:20', '13:00-21:00']);
  assert.deepEqual(periodsFor({}, FRI, DEFAULTS.schedule).map((x) => `${x.start}-${x.end}`), ['14:00-21:00']);
  assert.deepEqual(periodsFor({ periods: '["pm","fri"]' }, SAT, DEFAULTS.schedule).map((x) => x.id), ['pm']);
  assert.deepEqual(periodsFor({ day_off: 6 }, SAT, DEFAULTS.schedule), []);
});

test('on-time full day', () => {
  const d = computeDay({ date: SAT, periods, now: evening, grace: 10, salary: 3000,
    punches: [p('06:58', 'in'), p('12:21', 'out'), p('12:59', 'in'), p('21:02', 'out')] });
  assert.equal(d.status, 'present');
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.earlyMinutes, 0);
  assert.equal(d.exitMinutes, 0);
  assert.equal(d.suggested, 0);
});

test('lateness within grace is forgiven, beyond grace counts in full', () => {
  const ok = computeDay({ date: SAT, periods, now: evening, grace: 10,
    punches: [p('07:08', 'in'), p('12:20', 'out'), p('13:00', 'in'), p('21:00', 'out')] });
  assert.equal(ok.lateMinutes, 0);
  assert.equal(ok.exitMinutes, 0);
  const late = computeDay({ date: SAT, periods, now: evening, grace: 10,
    punches: [p('07:25', 'in'), p('12:20', 'out'), p('13:15', 'in'), p('21:00', 'out')] });
  assert.equal(late.lateMinutes, 40);
  assert.equal(late.status, 'late');
});

test('temporary exit and early leave', () => {
  const d = computeDay({ date: SAT, periods, now: evening, grace: 10, maxExit: 30,
    punches: [p('07:00', 'in'), p('09:00', 'leave', 'بنك'), p('09:45', 'back'), p('12:20', 'out'), p('13:00', 'in'), p('20:30', 'out')] });
  assert.equal(d.exitMinutes, 45);
  assert.equal(d.earlyMinutes, 30);
  assert.equal(d.exits[0].note, 'بنك');
  assert.ok(d.flags.includes('long_exit'));
});

test('absence and partial absence, with suggested deduction', () => {
  const absent = computeDay({ date: SAT, periods, now: evening, salary: 3000, punches: [] });
  assert.equal(absent.status, 'absent');
  assert.equal(absent.absentMinutes, 800);
  assert.equal(absent.suggested, 100); // one day's pay = 3000 / 30
  const partial = computeDay({ date: SAT, periods, now: evening, salary: 3000, punches: [p('13:00', 'in'), p('21:00', 'out')] });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.absentPeriods, 1);
  assert.equal(partial.suggested, 40); // 320 of 800 minutes
});

test('forgotten checkout is flagged on past days', () => {
  const d = computeDay({ date: SAT, periods, now: at('2026-10-04', '09:00'), punches: [p('07:00', 'in')] });
  assert.ok(d.flags.includes('missing_out'));
  assert.equal(d.overtimeMinutes, 0);
  const late = computeDay({ date: SAT, periods, now: at(SAT, '23:30'), punches: [p('07:00', 'in')] });
  assert.ok(late.flags.includes('missing_out'));
});

test('live state during the day', () => {
  const now = at(SAT, '08:00');
  const notYet = computeDay({ date: SAT, periods, now, grace: 10, punches: [] });
  assert.equal(notYet.status, 'not_arrived');
  assert.equal(notYet.lateMinutes, 60);
  assert.equal(notYet.suggested, 0);
  const inside = computeDay({ date: SAT, periods, now, grace: 10, punches: [p('07:02', 'in')] });
  assert.equal(inside.liveState, 'in');
  assert.equal(inside.status, 'present');
});

test('excused day carries no penalties; day off records overtime', () => {
  const ex = computeDay({ date: SAT, periods, now: evening, excuse: 'sick', punches: [] });
  assert.equal(ex.status, 'excused');
  assert.equal(ex.absentMinutes, 0);
  const off = computeDay({ date: SAT, periods: [], now: evening, punches: [p('10:00', 'in'), p('12:00', 'out')] });
  assert.equal(off.status, 'off_worked');
  assert.equal(off.overtimeMinutes, 120);
});

test('approved hourly permission is not lateness, exit or absence, and not time worked', () => {
  const permits = [[at(SAT, '07:00'), at(SAT, '09:00')]];
  const d = computeDay({ date: SAT, periods, now: evening, grace: 10, permits,
    punches: [p('09:00', 'in'), p('12:20', 'out'), p('13:00', 'in'), p('21:00', 'out')] });
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.status, 'present');
  assert.equal(d.periods[0].permitted, 120);
  assert.equal(d.presentMinutes, 680);
  const mid = computeDay({ date: SAT, periods, now: evening, grace: 10, permits: [[at(SAT, '15:00'), at(SAT, '16:00')]],
    punches: [p('07:00', 'in'), p('12:20', 'out'), p('13:00', 'in'), p('15:00', 'leave', 'بنك'), p('16:00', 'back'), p('21:00', 'out')] });
  assert.equal(mid.exitMinutes, 0);
  const whole = computeDay({ date: SAT, periods, now: evening, permits: [[at(SAT, '07:00'), at(SAT, '12:20')]],
    punches: [p('13:00', 'in'), p('21:00', 'out')] });
  assert.equal(whole.absentPeriods, 0);
});
