// Server-rendered daily report: open it, print it, or save as PDF from the browser.
import { localTime } from './time.js';
import { FLAG_LABELS } from './punch.js';
import { STATUS_LABELS, PUNCH_LABELS, DEDUCTION_LABELS, TICKET_KINDS, TICKET_STATUS, STOCK_KINDS } from './reports.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (ts) => (ts ? localTime(ts) : '—');
const hm = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '—');
const n = (v) => (v ? Number(v).toLocaleString('en-US') : '0');

function table(head, rows, empty = 'لا يوجد') {
  if (!rows.length) return `<p class="empty">${empty}</p>`;
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function renderDailyReport(d) {
  const dayName = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const att = d.attendance;
  const count = (s) => att.filter((r) => r.status === s).length;
  const ops = d.ops;
  const opsTotal = ops ? ops.totalOrders : 0;

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>التقرير اليومي ${esc(d.date)} | وريف</title><link rel="icon" href="/img/favicon.png"><link rel="stylesheet" href="/print.css"></head><body>
<header class="head">
  <img src="/img/logo-mark.png" alt="وريف" class="logo">
  <div><h1>التقرير اليومي</h1><p>${esc(dayName)}</p></div>
  <button type="button" id="print" class="noprint">طباعة أو حفظ PDF</button>
</header>

<section class="kpis">
  <div><b>${count('present') + count('late')}</b><span>حضروا</span></div>
  <div><b>${count('late')}</b><span>متأخرون</span></div>
  <div><b>${count('absent') + count('partial')}</b><span>غياب كلي أو جزئي</span></div>
  <div><b>${n(opsTotal)}</b><span>طلبات اليوم</span></div>
  <div><b>${n(ops?.shipments)}</b><span>شحنات</span></div>
  <div><b>${n(ops?.returns)}</b><span>مرتجعات</span></div>
</section>

<h2>الحضور والانصراف</h2>
${table(['الموظف', 'الحالة', 'أول حضور', 'آخر انصراف', 'تأخير (د)', 'انصراف مبكر (د)', 'خروج أثناء الدوام (د)', 'ساعات العمل', 'ملاحظات'],
    att.map((r) => [esc(r.name), `<span class="st st-${r.status}">${esc(STATUS_LABELS[r.status] || r.status)}</span>`, t(r.firstIn), t(r.lastOut),
      r.lateMinutes || '—', r.earlyMinutes || '—', r.exitMinutes || '—', hm(r.presentMinutes), esc(r.flags.map((f) => FLAG_LABELS[f] || f).join('، '))]))}

<h2>سجل البصمات</h2>
${table(['الوقت', 'الموظف', 'النوع', 'ملاحظة', 'مؤشرات'],
    d.punches.filter((p) => !p.voided).map((p) => [t(p.ts), esc(p.user_name), PUNCH_LABELS[p.type], esc(p.note), esc(p.flags.map((f) => FLAG_LABELS[f] || f).join('، '))]), 'لا توجد بصمات')}

<h2>الطلبات والشحن</h2>
${ops ? table(['القناة', 'عدد الطلبات', 'المبلغ (ر.س)'],
    [...d.channels.map((c) => [esc(c.name), n(ops.channels[c.key]?.count), n(ops.channels[c.key]?.amount)]),
      ['<b>الإجمالي</b>', `<b>${n(ops.totalOrders)}</b>`, `<b>${n(ops.totalAmount)}</b>`]])
    + (ops.notes ? `<p class="note">${esc(ops.notes)}</p>` : '') : '<p class="empty">لم تُسجَّل عمليات هذا اليوم</p>'}

<h2>مرتجعات التجار والبضائع الجديدة</h2>
${table(['النوع', 'التاجر / المورد', 'الوصف', 'الكمية', 'القيمة', 'ملاحظة'],
    d.stock.map((s) => [STOCK_KINDS[s.kind], esc(s.party), esc(s.description), n(s.quantity), n(s.value), esc(s.note)]))}

<h2>الملاحظات والإنجازات</h2>
${table(['#', 'الموظف', 'النوع', 'العنوان', 'التفاصيل', 'الحالة'],
    d.tickets.map((x) => [x.id, esc(x.user_name), TICKET_KINDS[x.kind], esc(x.title), esc(x.body), TICKET_STATUS[x.status]]))}

<h2>الخصومات والسلف المسجّلة اليوم</h2>
${table(['الموظف', 'النوع', 'المبلغ', 'التفاصيل'], [
    ...d.deductions.map((x) => [esc(x.user_name), `خصم: ${DEDUCTION_LABELS[x.category]}`, n(x.amount), esc(x.reason)]),
    ...d.debts.map((x) => [esc(x.user_name), x.kind === 'loan' ? 'سلفة' : 'سداد سلفة', n(x.amount), esc(x.note)]),
  ])}

<footer>وريف · فخامة تليق بك · صدر التقرير ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</footer>
<script src="/print.js"></script>
</body></html>`;
}
