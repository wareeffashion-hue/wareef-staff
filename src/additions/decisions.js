// Administrative decisions: written in the app, laid out on the Wareef decision template (letterhead,
// number, dates, articles, signature and stamp), issued as PDF to employees over WhatsApp, with a
// link to read and acknowledge it. The supervisor follows who received, opened and acknowledged.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { audit, tx } from '../db.js';
import { HttpError } from '../http.js';
import { htmlToPdf } from '../pdf.js';
import { localDate } from '../time.js';
import { waConnected, waSendDocument } from '../wa.js';
import { link, msg, toUser } from './alerts.js';
import { escHtml as esc, needDate, requireSup, text } from './util.js';

const asset = (name, type) => `data:${type};base64,${readFileSync(new URL(`./assets/${name}`, import.meta.url)).toString('base64')}`;
let ASSETS = null;
const assets = () => (ASSETS ??= {
  logo: asset('logo.png', 'image/png'), stamp: asset('stamp.png', 'image/png'),
  signature: asset('signature.png', 'image/png'), ribbon: asset('ribbon.svg', 'image/svg+xml'),
});

const ORG = 'مؤسسة تصاميم وريف التجارية';
const SIGNER = 'إبراهيم محمد عبدالله';
const ORDINALS = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة',
  'الحادية عشرة', 'الثانية عشرة', 'الثالثة عشرة', 'الرابعة عشرة', 'الخامسة عشرة'];

const at12 = (date) => new Date(`${date}T12:00:00Z`);
export const gregorian = (date) => `${new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at12(date)).replace('،', '')}م`;
export const hijri = (date) => new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at12(date)).replace(' هـ', 'هـ');
const hijriYear = (date) => Number(new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', timeZone: 'UTC' }).formatToParts(at12(date)).find((p) => p.type === 'year').value);

/** Light formatting in article text: **bold**, and lines starting with "-" or "•" become a list. */
function rich(body) {
  const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  let list = [];
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; } };
  for (const l of lines) {
    if (/^[-•]\s*/.test(l)) list.push(l.replace(/^[-•]\s*/, ''));
    else { flush(); out.push(`<p>${inline(l)}</p>`); }
  }
  flush();
  return out.join('');
}

/** The decision as an HTML page (also the PDF source). `bar` adds the acknowledgement bar for the web view. */
export function renderDecision(d, { bar = '' } = {}) {
  const a = assets();
  const articles = JSON.parse(d.articles || '[]');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`قرار إداري ${d.number}`)}</title>
<style>
@font-face { font-family: "Gamila"; src: url("/fonts/gamila-400.ttf"); font-weight: 400; }
@font-face { font-family: "Gamila"; src: url("/fonts/gamila-500.ttf"); font-weight: 500; }
@font-face { font-family: "Gamila"; src: url("/fonts/gamila-700.ttf"); font-weight: 700; }
@page { size: A4; margin: 0; }
:root { --ink: #17131f; --ink2: #3f3a4c; --muted: #7d7690; --line: rgb(28 22 52 / 12%);
  --foil: linear-gradient(90deg, #5fe3cb 0%, #86b0ff 28%, #ab86ff 50%, #ff8cc4 74%, #ffc27f 100%); }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 400 11px/1.64 Gamila, sans-serif; color: var(--ink); background: #e9e7ee; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.doc { position: relative; width: 210mm; min-height: 297mm; margin: 0 auto; padding: 13mm 17mm 18mm; background: #fff; overflow: hidden; }
.doc > * { position: relative; z-index: 1; }
.band { position: absolute; z-index: 1; top: 0; inset-inline: 0; height: 3.2mm; background: var(--foil); }
.wm { position: absolute; z-index: 0; inset-inline-start: -38mm; top: 52mm; width: 175mm; opacity: .055; }
header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8mm; padding-bottom: 4.5mm; border-bottom: 1.4px solid var(--ink); }
header .logo { height: 18mm; }
header .org b { font-size: 17px; display: block; line-height: 1.45; }
header .org span { color: var(--muted); font-size: 11px; }
.meta { display: grid; grid-template-columns: auto auto; gap: 1px 10px; font-size: 11px; margin: 0; }
.meta dt { color: var(--muted); } .meta dd { margin: 0; font-weight: 700; }
.title { text-align: center; margin: 5mm 0 3.5mm; }
.kicker { display: inline-block; font-size: 11px; color: var(--ink2); border: 1px solid var(--line); border-radius: 99px; padding: 1px 14px; margin-bottom: 3mm; }
.title h1 { margin: 0; font-size: 25px; line-height: 1.35; }
.title h1 small { display: block; font-size: 15px; font-weight: 500; color: var(--ink2); margin-top: 1mm; }
.rule { width: 46mm; height: 3px; border-radius: 3px; background: var(--foil); margin: 3.5mm auto 0; }
.preamble { text-align: justify; color: var(--ink2); margin: 0 0 2mm; }
.preamble b { color: var(--ink); }
.art { padding: 1.7mm 0; border-bottom: 1px dashed var(--line); break-inside: avoid; }
.art:last-of-type { border-bottom: 0; }
.art h3 { margin: 0 0 .3mm; font-size: 12.8px; display: flex; align-items: center; gap: 8px; }
.no { font-size: 11px; font-weight: 500; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
.no::after { content: "·"; }
.no i { width: 7px; height: 7px; border-radius: 50%; background: var(--foil); }
.art p { margin: 0; text-align: justify; color: var(--ink2); }
.art ul { margin: 0; padding-inline-start: 4.5mm; color: var(--ink2); }
.art b { color: var(--ink); }
.art.warn { background: linear-gradient(90deg, rgb(199 51 79 / 0%), rgb(199 51 79 / 5%)); border-radius: 10px; padding-inline: 3mm; border: 1px solid rgb(199 51 79 / 22%); margin: 1.2mm 0; }
.art.warn .no i { background: #c7334f; }
.sign { display: grid; grid-template-columns: 1fr 1.1fr 30mm; gap: 6mm; align-items: center; margin-top: 4mm; break-inside: avoid; }
.sign .who { display: grid; gap: 1px; } .sign .who b { font-size: 15px; }
.lbl { font-size: 10.5px; color: var(--muted); }
.sig { position: relative; display: grid; justify-items: center; border-bottom: 1px solid var(--line); padding-bottom: 1mm; }
.sig img { height: 16mm; margin-bottom: -2mm; } .sig .lbl { position: absolute; bottom: -5mm; }
.stamp { width: 28mm; transform: rotate(-9deg); opacity: .93; mix-blend-mode: multiply; }
.foot { position: absolute; bottom: 7mm; inset-inline: 17mm; display: flex; justify-content: space-between; font-size: 9.5px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 2mm; }
.ackbar { position: sticky; bottom: 0; z-index: 5; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 14px; background: rgb(255 255 255 / 94%); border-top: 1px solid var(--line); font-size: 14px; }
.ackbar button, .ackbar a { font: 700 15px Gamila, sans-serif; border: 0; border-radius: 10px; padding: 10px 22px; cursor: pointer; text-decoration: none; color: #120d1f; background: linear-gradient(115deg, #5fe3cb, #86b0ff 28%, #ab86ff 50%, #ff8cc4 74%, #ffc27f); }
.ackbar a { background: #fff; border: 1px solid var(--line); font-weight: 500; }
.ackbar .done { color: #128a5c; font-weight: 700; }
@media screen and (max-width: 820px) { .doc { width: 100%; min-height: 0; padding: 16px 16px 60px; } header { grid-template-columns: auto 1fr; } .meta { grid-column: 1 / -1; } .wm { display: none; } .sign { grid-template-columns: 1fr 1fr; } .sign .who { grid-column: 1 / -1; } }
@media print { body { background: #fff; } .ackbar { display: none; } }
</style></head><body>
<article class="doc">
  <div class="band"></div><img class="wm" src="${a.ribbon}" alt="">
  <header>
    <img class="logo" src="${a.logo}" alt="وريف">
    <div class="org"><b>${ORG}</b><span>WAREEF FASHION · س.ت 7037287153</span></div>
    <dl class="meta">
      <dt>رقم القرار</dt><dd>${esc(d.number)}</dd>
      <dt>تاريخ الإصدار</dt><dd>${esc(gregorian(d.issued_date))}</dd>
      <dt></dt><dd style="font-weight:500">${esc(hijri(d.issued_date))}</dd>
      <dt>يُعمل به من</dt><dd>${esc(gregorian(d.effective_date))}</dd>
    </dl>
  </header>
  <div class="title"><span class="kicker">قرار إداري</span>
    <h1>${esc(d.title)}${d.subtitle ? `<small>${esc(d.subtitle)}</small>` : ''}</h1><div class="rule"></div></div>
  ${d.preamble ? `<p class="preamble">${esc(d.preamble).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}${/تقرر/.test(d.preamble) ? '' : ' <b>تقرر الإدارة ما يلي:</b>'}</p>` : ''}
  ${articles.map((x, i) => `<div class="art${x.warn ? ' warn' : ''}"><h3><span class="no"><i></i>المادة ${ORDINALS[i] || i + 1}</span>${esc(x.title)}</h3>${rich(x.body)}</div>`).join('')}
  <div class="sign">
    <div class="who"><span class="lbl">يُعتمد،</span><b>${SIGNER}</b><span class="lbl">${ORG}</span></div>
    <div class="sig"><img src="${a.signature}" alt="التوقيع"><span class="lbl">التوقيع</span></div>
    <img class="stamp" src="${a.stamp}" alt="الختم">
  </div>
  <div class="foot"><span>${ORG} · قرار إداري ${esc(d.number)}</span><span>${esc(gregorian(d.issued_date))}</span></div>
</article>
${bar}
</body></html>`;
}

/** Next number for a Hijri year: ق.إ / 1448 / 002. Decision 001 of 1448 was issued before the system had decisions. */
function nextNumber(db, date) {
  const hy = hijriYear(date);
  const last = db.prepare('SELECT MAX(seq) s FROM decisions WHERE hijri_year = ?').get(hy).s;
  const seq = last ? last + 1 : (hy === 1448 ? 2 : 1);
  return { hy, seq, number: `ق.إ / ${hy} / ${String(seq).padStart(3, '0')}` };
}

function clean(body) {
  const title = text(body.title, 140);
  if (title.length < 3) throw new HttpError(400, 'اكتب عنوان القرار');
  const articles = (Array.isArray(body.articles) ? body.articles : []).slice(0, 15)
    .map((x) => ({ title: text(x?.title, 100), body: text(x?.body, 3000), warn: !!x?.warn })).filter((x) => x.title || x.body);
  if (!articles.length) throw new HttpError(400, 'أضف مادة واحدة على الأقل');
  const issued = needDate(body.issued_date, localDate());
  const effective = needDate(body.effective_date, issued);
  if (effective < issued) throw new HttpError(400, 'تاريخ العمل بالقرار قبل تاريخ إصداره');
  return { title, subtitle: text(body.subtitle, 140), preamble: text(body.preamble, 1500), articles: JSON.stringify(articles), issued_date: issued, effective_date: effective };
}

const getDecision = (db, id) => {
  const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(id));
  if (!d) throw new HttpError(404, 'القرار غير موجود');
  return d;
};

export function createDecision(db, user, body) {
  requireSup(user);
  const c = clean(body);
  const n = nextNumber(db, c.issued_date);
  const id = Number(db.prepare(`INSERT INTO decisions (seq, hijri_year, number, title, subtitle, preamble, articles, issued_date, effective_date, created_by, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(n.seq, n.hy, n.number, c.title, c.subtitle, c.preamble, c.articles, c.issued_date, c.effective_date, user.id, Date.now()).lastInsertRowid);
  audit(db, user.id, 'decision.create', null, { id, number: n.number });
  return { ok: true, id, decision: getDecision(db, id) };
}

export function updateDecision(db, user, id, body) {
  requireSup(user);
  const d = getDecision(db, id);
  if (d.status !== 'draft') throw new HttpError(400, 'القرار صدر ولا يُعدّل. أصدر قراراً جديداً');
  const c = clean({ ...d, articles: JSON.parse(d.articles || '[]'), ...body });
  db.prepare('UPDATE decisions SET title = ?, subtitle = ?, preamble = ?, articles = ?, issued_date = ?, effective_date = ? WHERE id = ?')
    .run(c.title, c.subtitle, c.preamble, c.articles, c.issued_date, c.effective_date, d.id);
  return { ok: true, decision: getDecision(db, d.id) };
}

export function deleteDecision(db, user, id) {
  requireSup(user);
  const d = getDecision(db, id);
  if (d.status !== 'draft') throw new HttpError(400, 'القرار صدر ولا يُحذف');
  db.prepare('DELETE FROM decisions WHERE id = ?').run(d.id);
  return { ok: true };
}

export function listDecisions(db, user) {
  requireSup(user);
  return {
    decisions: db.prepare(`SELECT d.*, u.name AS by_name,
        (SELECT COUNT(*) FROM decision_recipients r WHERE r.decision_id = d.id) AS recipients,
        (SELECT COUNT(*) FROM decision_recipients r WHERE r.decision_id = d.id AND r.file_status = 'sent') AS files_sent,
        (SELECT COUNT(*) FROM decision_recipients r WHERE r.decision_id = d.id AND r.seen_at IS NOT NULL) AS seen,
        (SELECT COUNT(*) FROM decision_recipients r WHERE r.decision_id = d.id AND r.ack_at IS NOT NULL) AS acked
      FROM decisions d LEFT JOIN users u ON u.id = d.created_by ORDER BY d.id DESC LIMIT 100`).all(),
  };
}

export function decisionDetail(db, user, id) {
  requireSup(user);
  const d = getDecision(db, id);
  const recipients = db.prepare(`SELECT r.user_id, r.file_status, r.file_attempts, r.file_error, r.file_sent_at, r.seen_at, r.ack_at, u.name, u.phone
                                 FROM decision_recipients r JOIN users u ON u.id = r.user_id WHERE r.decision_id = ? ORDER BY u.id`).all(d.id);
  return { decision: d, recipients };
}

/** Issue: the number is final, each employee gets the link on WhatsApp, and the PDF follows from the file queue. */
export function issueDecision(db, user, id, body) {
  requireSup(user);
  const d = getDecision(db, id);
  if (d.status !== 'draft') throw new HttpError(400, 'القرار صادر مسبقاً');
  const ids = body.user_ids === 'all'
    ? db.prepare("SELECT id FROM users WHERE role = 'employee' AND active = 1").all().map((r) => r.id)
    : [...new Set((Array.isArray(body.user_ids) ? body.user_ids : []).map(Number))].filter((x) => db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee' AND active = 1").get(x));
  if (!ids.length) throw new HttpError(400, 'اختر من يُبلَّغ بالقرار');
  if (!link(db, 'x')) throw new HttpError(400, 'اكتب «رابط النظام» في الإعدادات أولاً، عشان يوصل الموظف رابط الإقرار');
  const now = Date.now();
  tx(db, () => {
    db.prepare("UPDATE decisions SET status = 'issued', issued_by = ?, issued_at = ? WHERE id = ?").run(user.id, now, d.id);
    const ins = db.prepare('INSERT OR IGNORE INTO decision_recipients (decision_id, user_id, token) VALUES (?, ?, ?)');
    for (const uid of ids) ins.run(d.id, uid, randomBytes(18).toString('base64url'));
    audit(db, user.id, 'decision.issue', null, { id: d.id, number: d.number, recipients: ids.length });
  });
  for (const r of db.prepare('SELECT r.*, u.name FROM decision_recipients r JOIN users u ON u.id = r.user_id WHERE r.decision_id = ?').all(d.id)) {
    toUser(db, r.user_id, 'decision', msg.card({
      icon: '📜', title: `قرار إداري ${d.number}`, hello: `${r.name}،`, lines: [`صدر قرار إداري: *${d.title}*`, `يُعمل به من ${gregorian(d.effective_date)}.`],
      steps: ['افتح الرابط واقرأ القرار', 'اضغط «أقرّ بالاطلاع»', 'ملف القرار PDF يوصلك في رسالة مستقلة'], link: link(db, `ack/${r.token}`),
    }), `decision:${d.id}:${r.user_id}`);
  }
  return { ok: true, recipients: ids.length, number: getDecision(db, d.id).number };
}

/** Send failed files again (one person, or everyone whose file failed). */
export function resendFiles(db, user, id, body) {
  requireSup(user);
  const d = getDecision(db, id);
  const r = db.prepare(`UPDATE decision_recipients SET file_status = 'pending', file_attempts = 0, file_error = NULL
                        WHERE decision_id = ? AND file_status IN ('failed', 'no_phone') ${body.user_id ? 'AND user_id = ?' : ''}`).run(d.id, ...(body.user_id ? [Number(body.user_id)] : []));
  return { ok: true, queued: r.changes };
}

const pdfCache = new Map();
export async function decisionPdf(d) {
  const key = `${d.id}:${d.issued_at || d.created_at}`;
  if (!pdfCache.has(key)) {
    if (pdfCache.size > 20) pdfCache.clear();
    pdfCache.set(key, htmlToPdf(renderDecision(d)).catch((e) => { pdfCache.delete(key); throw e; }));
  }
  return pdfCache.get(key);
}

/** Every minute: PDF files of issued decisions go out one by one over the linked WhatsApp. */
let sending = false;
export async function decisionFilesTick(db) {
  if (sending || !waConnected()) return 0;
  sending = true;
  let sent = 0;
  try {
    const rows = db.prepare(`SELECT r.*, u.phone, d.id AS did FROM decision_recipients r JOIN users u ON u.id = r.user_id JOIN decisions d ON d.id = r.decision_id
                             WHERE r.file_status = 'pending' AND d.status = 'issued' ORDER BY r.decision_id, r.user_id LIMIT 10`).all();
    for (const r of rows) {
      const d = getDecision(db, r.did);
      if (!r.phone) { db.prepare("UPDATE decision_recipients SET file_status = 'no_phone', file_error = 'لا يوجد رقم جوال' WHERE decision_id = ? AND user_id = ?").run(r.decision_id, r.user_id); continue; }
      try {
        const pdf = await decisionPdf(d);
        await waSendDocument(r.phone, pdf, `قرار ${d.number.replace(/\s*\/\s*/g, '-')}.pdf`, `📜 ${d.title}`, 'application/pdf');
        db.prepare("UPDATE decision_recipients SET file_status = 'sent', file_sent_at = ?, file_attempts = file_attempts + 1, file_error = NULL WHERE decision_id = ? AND user_id = ?").run(Date.now(), r.decision_id, r.user_id);
        sent++;
      } catch (e) {
        if (e.defer) break;
        const n = r.file_attempts + 1;
        db.prepare('UPDATE decision_recipients SET file_status = ?, file_attempts = ?, file_error = ? WHERE decision_id = ? AND user_id = ?')
          .run(n >= 3 ? 'failed' : 'pending', n, String(e.message).slice(0, 300), r.decision_id, r.user_id);
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
  } finally {
    sending = false;
  }
  return sent;
}

// ------------------------------------------------------------------ acknowledgement (by link or in the app)
const byToken = (db, token) => db.prepare(`SELECT r.*, u.name FROM decision_recipients r JOIN users u ON u.id = r.user_id WHERE r.token = ?`).get(String(token || ''));

export function ackPage(db, token) {
  const r = byToken(db, token);
  if (!r) return null;
  if (!r.seen_at) db.prepare('UPDATE decision_recipients SET seen_at = ? WHERE decision_id = ? AND user_id = ?').run(Date.now(), r.decision_id, r.user_id);
  const d = getDecision(db, r.decision_id);
  const bar = r.ack_at
    ? `<div class="ackbar"><span class="done">✓ أقررت بالاطلاع على هذا القرار</span><a href="/ack/${esc(r.token)}/pdf">تحميل PDF</a></div>`
    : `<form class="ackbar" method="post" action="/ack/${esc(r.token)}"><span>${esc(r.name)}، بعد قراءة القرار:</span><button type="submit">أقرّ بالاطلاع على القرار</button><a href="/ack/${esc(r.token)}/pdf">تحميل PDF</a></form>`;
  return renderDecision(d, { bar });
}

export function ackByToken(db, token) {
  const r = byToken(db, token);
  if (!r) return false;
  const now = Date.now();
  db.prepare('UPDATE decision_recipients SET ack_at = COALESCE(ack_at, ?), seen_at = COALESCE(seen_at, ?) WHERE decision_id = ? AND user_id = ?').run(now, now, r.decision_id, r.user_id);
  return true;
}

export const decisionByToken = (db, token) => { const r = byToken(db, token); return r ? getDecision(db, r.decision_id) : null; };

/** The employee's own decisions (profile page). */
export const myDecisions = (db, user) => db.prepare(`SELECT d.id, d.number, d.title, d.effective_date, r.token, r.seen_at, r.ack_at FROM decision_recipients r
  JOIN decisions d ON d.id = r.decision_id WHERE r.user_id = ? ORDER BY d.id DESC LIMIT 50`).all(user.id);

export function ackInApp(db, user, id) {
  const r = db.prepare('SELECT token FROM decision_recipients WHERE decision_id = ? AND user_id = ?').get(Number(id), user.id);
  if (!r) throw new HttpError(404, 'القرار غير موجود');
  ackByToken(db, r.token);
  return { ok: true };
}
