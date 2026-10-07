import { HttpError } from './http.js';

const SAT_THU = [
  { id: 'am', name: 'الفترة الصباحية', start: '07:00', end: '12:20' },
  { id: 'pm', name: 'الفترة المسائية', start: '13:00', end: '21:00' },
];

export const DEFAULTS = {
  schedule: {
    // Keys are weekdays: 0 = Sunday ... 5 = Friday, 6 = Saturday.
    days: {
      0: SAT_THU, 1: SAT_THU, 2: SAT_THU, 3: SAT_THU, 4: SAT_THU,
      5: [{ id: 'fri', name: 'دوام الجمعة', start: '14:00', end: '21:00' }],
      6: SAT_THU,
    },
  },
  grace_minutes: 10,
  max_exit_minutes: 30,
  security: {
    allowed_ips: [],      // empty = any network
    geo: null,            // { lat, lng, radius } in metres
    require_geo: false,
    max_clock_skew_minutes: 5,
  },
  // Daily numbers employees report. `note: true` adds a notes field next to the number.
  // Who may fill each one is a permission on the employee: "m:<key>".
  metrics: [
    { key: 'orders_prepared', name: 'الطلبات المجهّزة', note: false },
    { key: 'shipments', name: 'الشحنات المرسلة', note: false },
    { key: 'returns_warehouse', name: 'مرتجعات دخلت المستودع', note: false },
    { key: 'returns_system', name: 'مرتجعات سُجّلت في النظام', note: false },
    { key: 'daily_edits', name: 'التعديلات اليومية', note: false },
    { key: 'pending_issues', name: 'الإشكاليات المعلّقة', note: true },
    { key: 'pending_chats', name: 'دردشات معلّقة بدون رد', note: false },
    { key: 'late_orders', name: 'الطلبات المتأخرة', note: false },
    { key: 'late_available', name: 'منها متوفرة', note: false },
    { key: 'late_unavailable', name: 'منها غير متوفرة', note: true },
  ],
  notify: {
    manager_phone: '',
    app_url: '',                 // system address shown at the bottom of messages
    remind_staff: true,          // remind employees to punch in / out
    remind_after_minutes: 10,
    shift_alerts: true,          // alarms before each period starts and when it ends (break / end of day)
    alert_before_minutes: 10,
    alert_manager: true,         // lateness, absence, suspicious punches, new requests and tickets
    staff_account: true,         // tell employees about deductions, loans, replies, request decisions
    daily_summary: true,
    summary_time: '21:30',
    summary_pdf: true,           // the daily summary arrives as the full daily report in PDF
    alert_all: true,             // the manager hears about every action: punches, entries, tickets, replies...
    monthly_auto: true,          // on the 1st: monthly report to the manager, employee of the month to everyone
    daily_backup: true,          // a copy of the database to the manager's WhatsApp every night
    backup_time: '23:30',
  },
  channels: [
    { key: 'salla', name: 'سلة' },
    { key: 'tabby', name: 'تابي' },
    { key: 'tamara', name: 'تمارا' },
    { key: 'madfu', name: 'مدفوع' },
    { key: 'myspay', name: 'ماي اس باي' },
  ],
};

export function getSettings(db) {
  const out = structuredClone(DEFAULTS);
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (!(key in out)) continue;
    const v = JSON.parse(value);
    out[key] = v && typeof v === 'object' && !Array.isArray(v) && key === 'notify' ? { ...out[key], ...v } : v;
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validSchedule(s) {
  if (!s || typeof s !== 'object' || !s.days) throw new HttpError(400, 'جدول الدوام غير صالح');
  const days = {};
  for (let d = 0; d < 7; d++) {
    const list = Array.isArray(s.days[d]) ? s.days[d] : [];
    days[d] = list.map((p) => {
      const id = String(p.id || '').trim().slice(0, 20);
      if (!/^[a-z0-9_-]+$/i.test(id)) throw new HttpError(400, 'معرّف الفترة يجب أن يكون بالأحرف الإنجليزية');
      if (!HHMM.test(p.start) || !HHMM.test(p.end) || p.start >= p.end) throw new HttpError(400, `وقت الفترة "${p.name || id}" غير صحيح`);
      return { id, name: String(p.name || id).slice(0, 40), start: p.start, end: p.end };
    }).sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < days[d].length; i++) {
      if (days[d][i].start < days[d][i - 1].end) throw new HttpError(400, 'فترات اليوم الواحد متداخلة');
    }
  }
  return { days };
}

export function saveSettings(db, patch) {
  const cur = getSettings(db);
  const next = { ...cur };
  if ('schedule' in patch) next.schedule = validSchedule(patch.schedule);
  if ('grace_minutes' in patch) next.grace_minutes = clampInt(patch.grace_minutes, 0, 120);
  if ('max_exit_minutes' in patch) next.max_exit_minutes = clampInt(patch.max_exit_minutes, 1, 600);
  if ('security' in patch) {
    const s = patch.security || {};
    const geo = s.geo && Number.isFinite(+s.geo.lat) && Number.isFinite(+s.geo.lng)
      ? { lat: +s.geo.lat, lng: +s.geo.lng, radius: clampInt(s.geo.radius || 150, 20, 5000) }
      : null;
    next.security = {
      allowed_ips: (Array.isArray(s.allowed_ips) ? s.allowed_ips : String(s.allowed_ips || '').split(/[\s,]+/))
        .map((x) => String(x).trim()).filter(Boolean).slice(0, 20),
      geo,
      require_geo: !!s.require_geo && !!geo,
      max_clock_skew_minutes: clampInt(s.max_clock_skew_minutes ?? 5, 1, 120),
    };
  }
  if ('channels' in patch) {
    const seen = new Set();
    next.channels = (patch.channels || []).map((c) => ({
      key: String(c.key || '').trim().toLowerCase().slice(0, 20),
      name: String(c.name || '').trim().slice(0, 40),
    })).filter((c) => /^[a-z0-9_]+$/.test(c.key) && c.name && !seen.has(c.key) && seen.add(c.key));
    if (!next.channels.length) throw new HttpError(400, 'أضف قناة طلبات واحدة على الأقل');
  }
  if ('notify' in patch) {
    const n = patch.notify || {};
    const phone = String(n.manager_phone || '').replace(/\D/g, '');
    if (phone && !/^\d{9,15}$/.test(phone)) throw new HttpError(400, 'رقم جوال المدير غير صحيح');
    if (n.summary_time && !HHMM.test(n.summary_time)) throw new HttpError(400, 'وقت الملخص اليومي غير صحيح');
    next.notify = {
      manager_phone: phone,
      app_url: /^https?:\/\/\S+$/.test(String(n.app_url || '').trim()) ? String(n.app_url).trim().slice(0, 200) : '',
      remind_staff: !!n.remind_staff,
      remind_after_minutes: clampInt(n.remind_after_minutes ?? 10, 1, 120),
      shift_alerts: !!n.shift_alerts,
      alert_before_minutes: clampInt(n.alert_before_minutes ?? 10, 1, 120),
      alert_manager: !!n.alert_manager,
      staff_account: !!n.staff_account,
      daily_summary: !!n.daily_summary,
      summary_time: n.summary_time || '21:30',
      summary_pdf: !!(n.summary_pdf ?? true),
      alert_all: !!(n.alert_all ?? true),
      monthly_auto: !!(n.monthly_auto ?? true),
      daily_backup: !!(n.daily_backup ?? true),
      backup_time: HHMM.test(n.backup_time || '') ? n.backup_time : '23:30',
    };
  }
  if ('metrics' in patch) {
    const seen = new Set();
    next.metrics = (patch.metrics || []).map((m) => ({
      key: String(m.key || '').trim().toLowerCase().slice(0, 30),
      name: String(m.name || '').trim().slice(0, 50),
      note: !!m.note,
    })).filter((m) => /^[a-z0-9_]+$/.test(m.key) && m.name && !seen.has(m.key) && seen.add(m.key));
  }
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of Object.keys(DEFAULTS)) up.run(k, JSON.stringify(next[k]));
  return next;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new HttpError(400, 'قيمة رقمية غير صحيحة');
  return Math.min(hi, Math.max(lo, n));
}

/** Distinct periods across the week, for assigning employees to shifts. */
export function allPeriods(schedule) {
  const map = new Map();
  for (let d = 0; d < 7; d++) for (const p of schedule.days[d] || []) if (!map.has(p.id)) map.set(p.id, p.name);
  return [...map].map(([id, name]) => ({ id, name }));
}

/** Every permission an employee can hold, for the staff screen. */
export function permissionList(settings) {
  return [
    { key: 'orders', name: 'تسجيل طلبات القنوات (سلة، تابي، تمارا...)' },
    { key: 'stock', name: 'فواتير البضائع الجديدة ومرتجعات التجار' },
    { key: 'requests', name: 'رفع طلبات الفسح والنواقص' },
    { key: 'supervisor', name: 'مشرف: يتابع الحضور والعمليات والطلبات والتذاكر، بدون الرواتب والخصومات والإعدادات' },
    ...settings.metrics.map((m) => ({ key: `m:${m.key}`, name: `رقم يومي: ${m.name}` })),
  ];
}
