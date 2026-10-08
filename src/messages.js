// Every WhatsApp message the system sends, built on one card template so they all look the same.
// WhatsApp formatting: *bold*  _italic_  ```mono```  > quote.

const RULE = '━━━━━━━━━━━━━━━';
const BRAND = '*وريف · فريق العمل*';
// "فخامة تليق بك" is for customers. The team gets a motivating line instead, a different one each day.
export const MOTTOS = [
  'كل طلب تجهّزه بإتقان، ابتسامة عند عميل 🤍',
  'الانضباط اليوم، نجاح بكرة',
  'فريق واحد، هدف واحد',
  'الإتقان عادة، مو صدفة',
  'تعبك اليوم يبني اسم وريف',
  'خطوة صغيرة كل يوم، فرق كبير كل شهر',
  'الدقة في التفاصيل تصنع الفخامة',
  'شغلك يوصل لبيوت عملائنا، خلّه يليق بهم',
  'يوم جديد، فرصة جديدة للتميّز',
  'نجاح الفريق يبدأ منك',
  'الالتزام أقصر طريق للتميّز',
  'الله يعطيك العافية على كل جهد',
];
const motto = (seed = '') => {
  const day = Math.floor((Date.now() + 3 * 3600_000) / 86_400_000);
  let h = day;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MOTTOS[h % MOTTOS.length];
};
const SIGN_MANAGER = '_وريف · لوحة المدير_';

const PUNCH = { in: 'تسجيل حضور', out: 'تسجيل انصراف', leave: 'خروج مؤقت', back: 'عودة' };
const sar = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;
const hourOf = (hhmm) => Number(String(hhmm).slice(0, 2));
export const greeting = (hhmm) => (hourOf(hhmm) < 12 ? 'صباح الخير' : 'مساء الخير');

/**
 * The card.
 * @param {object} c
 * @param {string} c.icon      one emoji for the message type
 * @param {string} c.title     what this is about, in a few words
 * @param {string} [c.hello]   personal greeting line
 * @param {string[]} [c.lines] the message itself
 * @param {Array<[string,string]>} [c.fields] label/value rows
 * @param {string[]} [c.steps] what to do now
 * @param {string} [c.quote]   a quoted note (reason, reply...)
 * @param {string} [c.link]    the system address
 * @param {boolean} [c.manager] manager alerts end with a plain signature instead of a motivating line
 */
export function card({ icon, title, hello, lines = [], fields = [], steps = [], quote, link, manager = false }) {
  const out = [BRAND, RULE, `${icon} *${title}*`, ''];
  if (hello) out.push(hello);
  out.push(...lines);
  if (fields.length) {
    if (hello || lines.length) out.push('');
    for (const [k, v] of fields) out.push(`▫️ ${k}: *${v}*`);
  }
  if (quote) out.push('', ...String(quote).split('\n').map((l) => `> ${l}`));
  if (steps.length) out.push('', ...steps.map((s) => `▸ ${s}`));
  if (link) out.push('', `🔗 ${link}`);
  out.push(RULE, manager ? SIGN_MANAGER : `✨ _${motto(title)}_`);
  return out.join('\n');
}

// ------------------------------------------------------------------ to employees
export const alarmStart = ({ name, period, start, now, grace, link }) => card({
  icon: '⏰', title: `منبّه ${period}`, hello: `${greeting(now)} ${name} 🌤️`,
  lines: [`فترتك تبدأ الساعة *${start}*`],
  steps: ['سجّل حضورك أول ما توصل', `السماح ${grace} دقائق، بعدها يُحسب التأخير`], link,
});

export const alarmBreak = ({ name, period, nextStart, link }) => card({
  icon: '☕', title: 'وقت الاستراحة', hello: `يعطيك العافية ${name}`,
  lines: [`انتهت ${period}.`],
  fields: [['الفترة القادمة تبدأ', nextStart]],
  steps: ['سجّل الانصراف الآن', 'وسجّل الحضور أول ما ترجع'], link,
});

export const alarmEnd = ({ name, end, link }) => card({
  icon: '🌙', title: 'نهاية الدوام', hello: `يعطيك العافية ${name}`,
  lines: [`انتهى دوامك اليوم الساعة *${end}*.`],
  steps: ['سجّل الانصراف قبل ما تطلع', 'وسجّل أرقامك اليومية إذا ما سجّلتها'], link,
});

export const remindIn = ({ name, period, start, link }) => card({
  icon: '🔔', title: 'ما سجّلت حضورك', hello: `${name}،`,
  lines: [`${period} بدأت الساعة *${start}* وما وصلتنا بصمتك.`],
  steps: ['سجّل بصمتك الآن', 'إذا عندك عذر بلّغ المدير'], link,
});

export const remindOut = ({ name, end, link }) => card({
  icon: '🔔', title: 'نسيت الانصراف؟', hello: `${name}،`,
  lines: [`انتهى دوامك الساعة *${end}* وما سجّلت انصراف.`],
  steps: ['إذا طلعت، سجّل الانصراف الآن'], link,
});

export const deduction = ({ amount, date, category, reason, link }) => card({
  icon: '📄', title: 'إشعار خصم',
  lines: ['تم تسجيل خصم على حسابك.'],
  fields: [['المبلغ', sar(amount)], ['التاريخ', date], ...(category ? [['البند', category]] : [])],
  quote: reason || undefined,
  steps: ['تفاصيل خصوماتك في «سجلي»', 'لأي استفسار تواصل مع المدير'], link,
});

export const debt = ({ kind, amount, balance, note, link }) => card({
  icon: kind === 'loan' ? '💳' : '✅', title: kind === 'loan' ? 'تم تسجيل سلفة' : 'تم تسجيل سداد',
  fields: [[kind === 'loan' ? 'مبلغ السلفة' : 'المبلغ المسدَّد', sar(amount)], ['المتبقي عليك', sar(balance)]],
  quote: note || undefined, link,
});

export const ticketReply = ({ title, reply, link }) => card({
  icon: '💬', title: 'رد على تذكرتك',
  fields: [['التذكرة', title]],
  quote: reply, link,
});

export const requestStatus = ({ id, kind, sku, qty, status, response, link, by = '' }) => {
  const icons = { approved: '✅', rejected: '⛔', done: '📦', pending: '⏳' };
  const labels = { approved: 'تمت الموافقة', rejected: 'مرفوض', done: 'تم التنفيذ', pending: 'بانتظار المدير' };
  return card({
    icon: icons[status] || '📌', title: `طلبك رقم ${id}: ${labels[status] || status}`,
    fields: [['النوع', kind === 'release' ? 'فسح لإرجاع منتجات' : 'طلب نواقص'], ['كود المنتج', sku], ['العدد', qty], ...(by ? [['رفعه', by]] : [])],
    quote: response || undefined, link,
  });
};

// ------------------------------------------------------------------ to the manager
export const mgrLate = ({ name, period, start, now }) => card({ manager: true,
  icon: '🟠', title: 'لم يصل بعد',
  fields: [['الموظف', name], ['الفترة', `${period} (${start})`], ['الوقت الآن', now]],
});

export const mgrAbsent = ({ name, period, start, end }) => card({ manager: true,
  icon: '🔴', title: 'غياب',
  fields: [['الموظف', name], ['الفترة', `${period} (${start} - ${end})`]],
  lines: [],
  steps: ['إذا كان معذوراً سجّل العذر من «الحضور والانصراف»'],
});

export const mgrFlag = ({ name, type, time, reasons }) => card({ manager: true,
  icon: '🚩', title: 'بصمة مشبوهة',
  fields: [['الموظف', name], ['البصمة', `${PUNCH[type]} الساعة ${time}`]],
  quote: reasons.join('\n'),
  steps: ['راجعها من «مؤشرات التلاعب»'],
});

export const mgrLeave = ({ name, time, reason }) => card({ manager: true,
  icon: '🚗', title: 'خروج مؤقت',
  fields: [['الموظف', name], ['الوقت', time]],
  quote: reason || undefined,
});

export const mgrTicket = ({ name, title, kind, high }) => card({ manager: true,
  icon: high ? '❗' : '🎫', title: high ? 'تذكرة بأولوية عالية' : 'تذكرة جديدة',
  fields: [['من', name], ['النوع', kind], ['العنوان', title]],
});

export const mgrRequest = ({ id, name, kind, sku, qty, reason }) => card({ manager: true,
  icon: kind === 'release' ? '↩️' : '📦', title: kind === 'release' ? 'طلب فسح لإرجاع منتجات' : 'طلب نواقص',
  fields: [['من', name], ['كود المنتج', sku], ['العدد', qty]],
  quote: reason,
  steps: [`للموافقة من هنا اكتب: *موافق ف${id}*`, `وللرفض: *رفض ف${id}* ثم السبب`, 'أو من «الفسح والنواقص» في النظام'],
});

export const test = ({ link }) => card({
  icon: '✨', title: 'الإشعارات تعمل',
  lines: ['هذي رسالة تجربة من نظام فريق وريف.', 'من الآن توصل المنبّهات والتنبيهات على هذا الشكل.'], link,
});

// ------------------------------------------------------------------ leave & permission requests
export const LEAVE_KINDS = { leave: 'إجازة', sick: 'إجازة مرضية', permission: 'استئذان' };
export const leaveWhen = (q) => (q.kind === 'permission' && q.minutes ? `خروج ${q.minutes} دقيقة يوم ${q.from_date}` : q.kind === 'permission'
  ? `${q.from_date} من ${q.from_time} إلى ${q.to_time}`
  : q.from_date === q.to_date ? q.from_date : `من ${q.from_date} إلى ${q.to_date}`);

export const mgrLeaveRequest = ({ q, name }) => card({
  manager: true, icon: q.kind === 'sick' ? '🤒' : q.kind === 'permission' ? '🕐' : '🌴', title: `طلب ${LEAVE_KINDS[q.kind]}`,
  fields: [['من', name], ['الموعد', leaveWhen(q)]],
  quote: q.reason || undefined,
  steps: [`للموافقة من هنا اكتب: *موافق ج${q.id}*`, `وللرفض: *رفض ج${q.id}* ثم السبب`],
});

export const leaveDecision = ({ q, link }) => card({
  icon: q.status === 'approved' ? '✅' : '⛔', title: `${LEAVE_KINDS[q.kind]}: ${q.status === 'approved' ? 'تمت الموافقة' : 'مرفوض'}`,
  fields: [['الموعد', leaveWhen(q)]],
  quote: q.response || undefined,
  lines: q.status === 'approved' && q.kind !== 'permission' ? ['أيام الإجازة ما يُحسب فيها غياب ولا تأخير.'] : q.status === 'approved' ? ['وقت الاستئذان ما يُحسب تأخير ولا خروج.'] : [],
  link,
});

// ------------------------------------------------------------------ WhatsApp commands
const DECIDED = { approved: ['✅', 'تمت الموافقة'], rejected: ['⛔', 'تم الرفض'], done: ['📦', 'تم التنفيذ'] };
export const commandDone = ({ what, status, name, detail }) => card({ manager: true,
  icon: DECIDED[status][0], title: DECIDED[status][1],
  fields: [['الطلب', what], ['الموظف', name], ...(detail ? [['التفاصيل', detail]] : [])],
  lines: ['وصل الإشعار للموظف المعني.'],
});

export const commandFailed = ({ reason }) => card({ manager: true,
  icon: '⚠️', title: 'ما تم التنفيذ', quote: reason,
  steps: ['اكتب *طلبات* لعرض ما ينتظر ردك'],
});

export const pendingList = ({ reqs, leaves }) => card({ manager: true,
  icon: '📌', title: 'بانتظار ردك',
  lines: [
    ...(reqs.length ? ['*الفسح والنواقص*', ...reqs.map((q) => `ف${q.id} · ${q.name} · ${q.kind === 'release' ? 'فسح' : 'نواقص'} ${q.sku} × ${q.quantity}`)] : []),
    ...(reqs.length && leaves.length ? [''] : []),
    ...(leaves.length ? ['*الإجازات والاستئذان*', ...leaves.map((q) => `ج${q.id} · ${q.name} · ${LEAVE_KINDS[q.kind]} ${leaveWhen(q)}`)] : []),
    ...(!reqs.length && !leaves.length ? ['لا يوجد شيء بانتظارك 👌'] : []),
  ],
  steps: reqs.length || leaves.length ? ['للموافقة: *موافق ف12* أو *موافق ج3*', 'للرفض: *رفض ف12 السبب*', 'للتنفيذ: *تم ف12*'] : [],
});

// ------------------------------------------------------------------ manager: every action
const PUNCH_ICON = { in: '🟢', out: '🔵', leave: '🚗', back: '↩️' };
export const mgrPunch = ({ name, type, time, late = 0 }) => card({ manager: true,
  icon: PUNCH_ICON[type] || '🕘', title: `${PUNCH[type]}: ${name}`,
  fields: [['الوقت', time], ...(late ? [['تأخير', `${late} دقيقة`]] : [])],
});

export const mgrEntry = ({ name, date, lines }) => card({ manager: true,
  icon: '📝', title: `تسجيل جديد من ${name}`,
  fields: [['اليوم', date]],
  lines: ['', ...lines],
});

export const mgrStock = ({ name, kind, party, invoice, lines }) => card({ manager: true,
  icon: kind === 'merchant_return' ? '↩️' : '📥', title: kind === 'merchant_return' ? 'مرتجع للتاجر' : 'فاتورة بضاعة جديدة',
  fields: [['سجّلها', name], ['التاجر', party], ...(invoice ? [['رقم الفاتورة', invoice]] : []), ['الأصناف', lines.length]],
  quote: lines.slice(0, 12).map((l) => `${l.sku || l.description} × ${l.quantity}`).join('\n') + (lines.length > 12 ? `\n… و${lines.length - 12} أصناف أخرى` : ''),
});

export const RETURN_STATUS = { ready: 'جاهز للإرسال', sent: 'أُرسل للتاجر', settled: 'تمت التسوية' };
export const mgrReturnStatus = ({ name, party, sku, qty, status, note }) => card({ manager: true,
  icon: status === 'settled' ? '✅' : status === 'sent' ? '🚚' : '📦', title: `مرتجع التاجر: ${RETURN_STATUS[status]}`,
  fields: [['التاجر', party], ['الصنف', `${sku} × ${qty}`], ['بواسطة', name]],
  quote: note || undefined,
});

export const mgrTicketReply = ({ name, title, reply }) => card({ manager: true,
  icon: '💬', title: `رد من ${name}`,
  fields: [['التذكرة', title]], quote: reply,
});

export const mgrPasswordReset = ({ name }) => card({ manager: true,
  icon: '🔑', title: 'استعادة كلمة مرور',
  lines: [`${name} غيّر كلمة المرور برمز التحقق.`],
});

// ------------------------------------------------------------------ accounts
export const otp = ({ code }) => card({
  icon: '🔐', title: 'رمز التحقق',
  lines: [`رمزك: *${code}*`, 'صالح لمدة 10 دقائق.'],
  steps: ['لا تعطيه لأي أحد', 'إذا ما طلبته تجاهل الرسالة'],
});

export const backupCaption = ({ date }) => `🗄️ *نسخة احتياطية · ${date}*\nاحتفظ بالملف. لاسترجاعه ارفعه في Railway باسم wareef.db داخل /data.\n_وريف · لوحة المدير_`;

// ------------------------------------------------------------------ month
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export const payslip = ({ name, month, r, link }) => card({
  icon: '🧾', title: `مسيّر راتب ${monthName(month)}`, hello: `${name}،`,
  lines: ['تم اعتماد مسيّر الشهر، وهذي تفاصيل راتبك:'],
  fields: [
    ['الراتب', sar(r.salary)],
    ...(r.workDays ? [['أيام الحضور', `${r.presentDays} من ${r.workDays}`]] : []),
    ...(r.absentDays ? [['أيام الغياب', r.absentDays]] : []),
    ...(r.lateMinutes ? [['دقائق التأخير', r.lateMinutes]] : []),
    ...(r.deductions ? [['الخصومات', sar(r.deductions)]] : []),
    ...(r.repayments ? [['أقساط السلف', sar(r.repayments)]] : []),
    ['صافي الراتب', sar(r.net)],
    ...(r.debtBalance ? [['المتبقي من السلف', sar(r.debtBalance)]] : []),
  ],
  steps: ['القسيمة كاملة في «سجلي» داخل النظام'], link,
});

export const award = ({ name, month, score, isYou, details }) => card({
  icon: '🏆', title: `موظف شهر ${monthName(month)}`,
  hello: isYou ? `مبروك ${name}! 🎉` : undefined,
  lines: isYou
    ? ['أنت موظف الشهر بجدارة. شكراً على التزامك وجهدك، وننتظر منك الأكثر 🤍']
    : [`نبارك لزميلنا *${name}* لقب موظف الشهر 🎉`, 'المنافسة مفتوحة للشهر الجاي، الالتزام والإنجاز هما الطريق.'],
  fields: [['التقييم', `${score} من 100`]],
  quote: details || undefined,
});

// ------------------------------------------------------------------ exit permission
export const mgrExitRequest = ({ q, name, time }) => card({ manager: true,
  icon: '🚪', title: `طلب إذن خروج: ${name}`,
  fields: [['المدة', `${q.minutes} دقيقة`], ['وقت الطلب', time]],
  quote: q.reason || undefined,
  steps: [`للموافقة اكتب: *موافق ج${q.id}*`, `وللرفض: *رفض ج${q.id}* ثم السبب`, 'أو من «لوحة اليوم» في النظام'],
});

export const exitDecision = ({ q, link }) => card({
  icon: q.status === 'approved' ? '✅' : '⛔', title: q.status === 'approved' ? 'تمت الموافقة على خروجك' : 'لم تتم الموافقة على الخروج',
  fields: [['المدة', `${q.minutes} دقيقة`]],
  quote: q.response || undefined,
  steps: q.status === 'approved' ? ['اضغط «اخرج الآن» في النظام وقت ما تطلع', 'وأول ما توصل اضغط «رجعت للمكتب»', `الوقت يبدأ من لحظة خروجك (${q.minutes} دقيقة)`] : [],
  link,
});

export const exitOver = ({ name, minutes, back, link }) => card({
  icon: '⏳', title: 'انتهى وقت الخروج', hello: `${name}،`,
  lines: [`إذن خروجك ${minutes} دقيقة انتهى الساعة *${back}*.`],
  steps: ['أول ما توصل اضغط «رجعت للمكتب»', 'الوقت الزائد يُحسب خروجاً أثناء الدوام'], link,
});

export const mgrExitOver = ({ name, minutes, left, over }) => card({ manager: true,
  icon: '⏳', title: `${name} تجاوز وقت الخروج`,
  fields: [['خرج الساعة', left], ['الإذن', `${minutes} دقيقة`], ['متأخر عن الرجوع', `${over} دقيقة`]],
});

export const mgrBack = ({ name, time, minutes, used, over }) => card({ manager: true,
  icon: over ? '🟠' : '↩️', title: `رجع للمكتب: ${name}`,
  fields: [['الوقت', time], ...(minutes ? [['الإذن', `${minutes} دقيقة`], ['المدة الفعلية', `${used} دقيقة`]] : []), ...(over ? [['تجاوز الإذن', `${over} دقيقة`]] : [])],
});

// ------------------------------------------------------------------ barcode
export const mgrScanDup = ({ name, reason }) => card({ manager: true,
  icon: '🔁', title: 'مسح مكرر بالباركود',
  fields: [['الموظف', name]], quote: reason,
});

// ------------------------------------------------------------------ exchanges shipped ahead
export const exchangeArrived = ({ tracking, order, customer, kind, by, days, link }) => card({
  icon: '📦', title: 'وصلت شحنة الإرجاع',
  lines: [`قطعة العميل وصلت المستودع${days ? ` بعد ${days} ${days === 1 ? 'يوم' : days === 2 ? 'يومين' : 'أيام'}` : ' اليوم'}.`],
  fields: [['رقم الشحنة', tracking], ...(order ? [['الطلب', order]] : []), ...(customer ? [['العميل', customer]] : []), ['النوع', kind], ...(by ? [['استلمها', by]] : [])],
  link,
});

export const exchangeDue = ({ tracking, order, customer, phone, kind, days, date, link }) => card({
  icon: '⏰', title: 'شحنة إرجاع ما وصلت',
  lines: [`مرّت *${days} أيام* من تسجيلها (${date}) وما وصلتنا قطعة العميل، والبديل انشحن له.`],
  fields: [['رقم الشحنة', tracking], ...(order ? [['الطلب', order]] : []), ...(customer ? [['العميل', customer]] : []), ...(phone ? [['جوال العميل', phone]] : []), ['النوع', kind]],
  steps: ['تواصل مع العميل وتأكد إنه أرسل الشحنة', 'اكتب نتيجة المتابعة في ملاحظة الشحنة بالنظام'],
  link,
});

export const mgrExchangeNew = ({ name, kind, tracking, order, customer }) => card({ manager: true,
  icon: '🔄', title: `${kind} مسبق: ${name}`,
  fields: [['رقم شحنة الإرجاع', tracking], ...(order ? [['الطلب', order]] : []), ...(customer ? [['العميل', customer]] : [])],
});

export const mgrExchangeArrived = ({ tracking, order, customer, kind, by, days }) => card({ manager: true,
  icon: '📦', title: `وصلت شحنة إرجاع (${kind})`,
  fields: [['رقم الشحنة', tracking], ...(order ? [['الطلب', order]] : []), ...(customer ? [['العميل', customer]] : []), ...(by ? [['استلمها', by]] : []), ['بعد', `${days} يوم`]],
});

export const mgrExchangeDue = ({ tracking, order, customer, kind, days, name }) => card({ manager: true,
  icon: '⏰', title: `شحنة إرجاع متأخرة ${days} أيام`,
  fields: [['رقم الشحنة', tracking], ['النوع', kind], ...(order ? [['الطلب', order]] : []), ...(customer ? [['العميل', customer]] : []), ...(name ? [['سجّلها', name]] : [])],
  steps: [name ? `وصل ${name} إشعار يتابع العميل` : 'يحتاج متابعة مع العميل'],
});
