// Server-rendered daily report: open it, print it, or save as PDF from the browser.
import { localDate, localTime } from './time.js';
const issued = () => `${localDate()} ${localTime(Date.now())}`;
import { FLAG_LABELS } from './punch.js';
import { monthName } from './messages.js';
import { STATUS_LABELS, PUNCH_LABELS, DEDUCTION_LABELS, TICKET_KINDS, TICKET_STATUS, STOCK_KINDS, REQUEST_KINDS, REQUEST_STATUS } from './reports.js';

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
  const metric = (k) => ops?.metrics?.[k]?.value;

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
  <div><b>${n(metric('shipments'))}</b><span>شحنات</span></div>
  <div><b>${n(metric('returns_warehouse'))}</b><span>مرتجعات للمستودع</span></div>
</section>

<h2>الحضور والانصراف</h2>
${table(['الموظف', 'الحالة', 'أول حضور', 'آخر انصراف', 'تأخير (د)', 'انصراف مبكر (د)', 'خروج أثناء الدوام (د)', 'ساعات العمل', 'ملاحظات'],
    att.map((r) => [esc(r.name), `<span class="st st-${r.status}">${esc(STATUS_LABELS[r.status] || r.status)}</span>`, t(r.firstIn), t(r.lastOut),
      r.lateMinutes || '—', r.earlyMinutes || '—', r.exitMinutes || '—', hm(r.presentMinutes), esc(r.flags.map((f) => FLAG_LABELS[f] || f).join('، '))]))}

<h2>سجل البصمات</h2>
${table(['الوقت', 'الموظف', 'النوع', 'ملاحظة', 'مؤشرات'],
    d.punches.filter((p) => !p.voided).map((p) => [t(p.ts), esc(p.user_name), PUNCH_LABELS[p.type], esc(p.note), esc(p.flags.map((f) => FLAG_LABELS[f] || f).join('، '))]), 'لا توجد بصمات')}

<h2>الطلبات حسب القناة</h2>
${ops && ops.totalOrders ? table(['القناة', 'عدد الطلبات', 'المبلغ (ر.س)'],
    [...d.channels.map((c) => [esc(c.name), n(ops.channels[c.key]?.count), n(ops.channels[c.key]?.amount)]),
      ['<b>الإجمالي</b>', `<b>${n(ops.totalOrders)}</b>`, `<b>${n(ops.totalAmount)}</b>`]])
    + (ops.notes ? `<p class="note">${esc(ops.notes)}</p>` : '') : '<p class="empty">لم تُسجَّل طلبات القنوات لهذا اليوم</p>'}

<h2>الأرقام اليومية</h2>
${table(['البند', 'العدد', 'ملاحظات', 'سجّلها'], d.metrics.filter((m) => ops?.metrics?.[m.key]).map((m) => {
    const v = ops.metrics[m.key];
    return [esc(m.name), `<b>${n(v.value)}</b>`, esc(v.note), esc(v.by)];
  }), 'لم تُسجَّل أرقام لهذا اليوم')}

<h2>المسح بالباركود</h2>
${d.scans.length ? ['shipment', 'return'].map((k) => {
    const list = d.scans.filter((s) => s.kind === k);
    return `<p class="note"><b>${k === 'shipment' ? 'شحنات طالعة' : 'مرتجعات من العملاء'}: ${list.length}</b>${list.length ? ` · <span dir="ltr">${list.map((s) => esc(s.code)).join('  ·  ')}</span>` : ''}</p>`;
  }).join('') : '<p class="empty">لم يُمسح شيء بالباركود لهذا اليوم</p>'}

<h2>فواتير البضائع ومرتجعات التجار</h2>
${table(['النوع', 'التاجر', 'رقم الفاتورة', 'كود المنتج', 'العدد', 'القيمة', 'ملاحظة'],
    d.stock.map((s) => [STOCK_KINDS[s.kind], esc(s.party), esc(s.invoice_no), esc(s.sku || s.description), n(s.quantity), n(s.value), esc(s.note)]))}

<h2>طلبات الفسح والنواقص</h2>
${table(['#', 'الموظف', 'النوع', 'كود المنتج', 'العدد', 'السبب', 'الحالة'],
    d.requests.map((q) => [q.id, esc(q.user_name), REQUEST_KINDS[q.kind], esc(q.sku), n(q.quantity), esc(q.reason), REQUEST_STATUS[q.status]]))}

<h2>الملاحظات والإنجازات</h2>
${table(['#', 'الموظف', 'النوع', 'العنوان', 'التفاصيل', 'الحالة'],
    d.tickets.map((x) => [x.id, esc(x.user_name), TICKET_KINDS[x.kind], esc(x.title), esc(x.body), TICKET_STATUS[x.status]]))}

${d.money === false ? '' : `<h2>الخصومات والسلف المسجّلة اليوم</h2>
${table(['الموظف', 'النوع', 'المبلغ', 'التفاصيل'], [
    ...d.deductions.map((x) => [esc(x.user_name), `خصم: ${DEDUCTION_LABELS[x.category]}`, n(x.amount), esc(x.reason)]),
    ...d.debts.map((x) => [esc(x.user_name), x.kind === 'loan' ? 'سلفة' : 'سداد سلفة', n(x.amount), esc(x.note)]),
  ])}`}

<footer>وريف · فريق العمل · صدر التقرير ${esc(issued())}</footer>
<script src="/print.js"></script>
</body></html>`;
}

const sar = (v) => `${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;
const page = (title, body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | وريف</title><link rel="icon" href="/img/favicon.png"><link rel="stylesheet" href="/print.css"></head><body>${body}
<footer>وريف · فريق العمل · صدر ${esc(issued())}</footer>
<script src="/print.js"></script></body></html>`;

export function renderPayslip({ month, row: r, closed, deductions, debts }) {
  return page(`قسيمة راتب ${r.name} ${month}`, `
<header class="head">
  <img src="/img/logo-mark.png" alt="وريف" class="logo">
  <div><h1>قسيمة راتب</h1><p>${esc(r.name)} · ${esc(monthName(month))} ${closed ? '' : '<span class="draft">مسودة: الشهر لم يُقفل</span>'}</p></div>
  <button type="button" id="print" class="noprint">طباعة أو حفظ PDF</button>
</header>
<section class="kpis">
  <div><b>${r.presentDays}/${r.workDays}</b><span>أيام الحضور</span></div>
  <div><b>${r.absentDays}</b><span>أيام الغياب</span></div>
  <div><b>${r.lateMinutes}</b><span>دقائق التأخير</span></div>
  <div><b>${r.exitMinutes + r.earlyMinutes}</b><span>دقائق خروج وانصراف مبكر</span></div>
</section>
<h2>الراتب</h2>
<div class="slip"><table><tbody>
  <tr><td>الراتب الأساسي</td><td>${sar(r.salary)}</td></tr>
  <tr><td>الخصومات المعتمدة</td><td>− ${sar(r.deductions)}</td></tr>
  <tr><td>أقساط السلف</td><td>− ${sar(r.repayments)}</td></tr>
  <tr class="total"><td>صافي الراتب</td><td>${sar(r.net)}</td></tr>
</tbody></table></div>
<p class="note">المتبقي من السلف بعد هذا الشهر: <b>${sar(r.debtBalance)}</b></p>
<h2>تفاصيل الخصومات</h2>
${table(['التاريخ', 'البند', 'المبلغ', 'التفاصيل'], deductions.map((x) => [x.date, DEDUCTION_LABELS[x.category] || '', n(x.amount), esc(x.reason)]), 'لا توجد خصومات')}
<h2>السلف والسداد</h2>
${table(['التاريخ', 'النوع', 'المبلغ', 'ملاحظة'], debts.map((x) => [x.date, x.kind === 'loan' ? 'سلفة' : 'سداد', n(x.amount), esc(x.note)]), 'لا توجد حركات')}
<div class="sign"><div>توقيع الموظف</div><div>اعتماد المدير</div></div>`);
}

export function renderMonthlyReport(d, money = true) {
  const sum = (k) => d.payroll.reduce((t, r) => t + (r[k] || 0), 0);
  const bar = (v) => (v === null ? '—' : `<div style="display:flex;gap:8px;align-items:center"><div class="bar"><i style="width:${v}%"></i></div><b>${v}</b></div>`);
  return page(`التقرير الشهري ${d.month}`, `
<header class="head">
  <img src="/img/logo-mark.png" alt="وريف" class="logo">
  <div><h1>التقرير الشهري</h1><p>${esc(monthName(d.month))} · ${d.closed ? 'المسيّر مقفل' : 'الشهر مفتوح'}</p></div>
  <button type="button" id="print" class="noprint">طباعة أو حفظ PDF</button>
</header>
<section class="kpis">
  <div><b>${n(d.totalOrders)}</b><span>إجمالي الطلبات</span></div>
  <div><b>${n(d.totalAmount)}</b><span>إجمالي المبالغ (ر.س)</span></div>
  <div><b>${n(sum('lateMinutes'))}</b><span>دقائق التأخير</span></div>
  <div><b>${n(sum('absentDays'))}</b><span>أيام الغياب</span></div>
  ${money ? `<div><b>${n(sum('deductions'))}</b><span>الخصومات (ر.س)</span></div><div><b>${n(Math.round(sum('net')))}</b><span>صافي الرواتب (ر.س)</span></div>` : ''}
</section>
${d.award ? `<p>🏆 موظف الشهر: <b>${esc(d.award.name)}</b> (${d.award.score} من 100)</p>` : ''}
<h2>الطلبات حسب القناة</h2>
${table(['القناة', 'عدد الطلبات', 'المبلغ (ر.س)'], [...d.channels.map((c) => [esc(c.name), n(c.count), n(c.amount)]), ['<b>الإجمالي</b>', `<b>${n(d.totalOrders)}</b>`, `<b>${n(d.totalAmount)}</b>`]])}
<h2>العمليات</h2>
${table(['البند', 'الإجمالي', 'أيام التسجيل'], d.metrics.map((m) => [esc(m.name), `<b>${n(m.total)}</b>`, m.days]))}
<h2>البضائع ومرتجعات التجار</h2>
${table(['البند', 'العدد', 'الكمية', 'الحالة'], [
    ['فواتير بضاعة جديدة', n(d.stock.invoices.n), n(d.stock.invoices.q), '—'],
    ['أصناف مرتجعة للتجار', n(d.stock.returns.n), n(d.stock.returns.q), `جاهز ${n(d.stock.returns.ready)} · أُرسل ${n(d.stock.returns.sent)} · تمت التسوية ${n(d.stock.returns.settled)}`],
  ])}
<h2>تقييم الأداء</h2>
${table(['#', 'الموظف', 'التقييم', 'الالتزام', 'التسجيل اليومي', 'الحضور', 'التأخير (د)', 'إنجازات', 'مقارنة بالشهر السابق'],
    d.performance.map((r) => [r.rank ?? '—', esc(r.name), bar(r.score), r.commitment ?? '—', r.recording ?? '—', `${r.presentDays}/${r.expectedDays}`, r.lateMinutes, r.achievements,
      r.change === null ? '—' : r.change > 0 ? `▲ ${r.change}` : r.change < 0 ? `▼ ${-r.change}` : '='])) }
<h2>الحضور${money ? ' والرواتب' : ''}</h2>
${table(['الموظف', 'الحضور', 'الغياب', 'أيام التأخير', 'دقائق التأخير', 'خروج (د)', ...(money ? ['الراتب', 'الخصومات', 'أقساط السلف', 'الصافي'] : [])],
    d.payroll.map((r) => [esc(r.name), `${r.presentDays}/${r.workDays}`, r.absentDays, r.lateDays, r.lateMinutes, r.exitMinutes + r.earlyMinutes,
      ...(money ? [n(r.salary), n(r.deductions), n(r.repayments), `<b>${n(r.net)}</b>`] : [])]))}
<h2>الطلبات والتذاكر والإجازات</h2>
${table(['البند', 'العدد'], [
    ['طلبات فسح ونواقص', n(Object.values(d.requests).reduce((a, b) => a + b, 0))],
    ['منها بانتظار المدير', n(d.requests.pending)],
    ['تذاكر الإنجازات', n(d.tickets.achievement)],
    ['ملاحظات ومشاكل وطلبات', n((d.tickets.note || 0) + (d.tickets.issue || 0) + (d.tickets.request || 0))],
    ['إجازات معتمدة', n((d.leaves.leave || 0) + (d.leaves.sick || 0))],
    ['استئذانات معتمدة', n(d.leaves.permission)],
  ])}`);
}
