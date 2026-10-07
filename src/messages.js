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

export const requestStatus = ({ id, kind, sku, qty, status, response, link }) => {
  const icons = { approved: '✅', rejected: '⛔', done: '📦', pending: '⏳' };
  const labels = { approved: 'تمت الموافقة', rejected: 'مرفوض', done: 'تم التنفيذ', pending: 'بانتظار المدير' };
  return card({
    icon: icons[status] || '📌', title: `طلبك رقم ${id}: ${labels[status] || status}`,
    fields: [['النوع', kind === 'release' ? 'فسح لإرجاع منتجات' : 'طلب نواقص'], ['كود المنتج', sku], ['العدد', qty]],
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

export const mgrRequest = ({ name, kind, sku, qty, reason }) => card({ manager: true,
  icon: kind === 'release' ? '↩️' : '📦', title: kind === 'release' ? 'طلب فسح لإرجاع منتجات' : 'طلب نواقص',
  fields: [['من', name], ['كود المنتج', sku], ['العدد', qty]],
  quote: reason,
  steps: ['وافق أو ارفض من «الفسح والنواقص»'],
});

export const test = ({ link }) => card({
  icon: '✨', title: 'الإشعارات تعمل',
  lines: ['هذي رسالة تجربة من نظام فريق وريف.', 'من الآن توصل المنبّهات والتنبيهات على هذا الشكل.'], link,
});
