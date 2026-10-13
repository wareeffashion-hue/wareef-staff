// Routes and periodic jobs of the additions, registered from server.js with one call.
import { HttpError, parseJson, readBody, send } from '../http.js';
import { monthBounds, localDate } from '../time.js';
import { renderPayslip } from '../print.js';
import { payrollFor } from '../monthly.js';
import { debtRows, deductionRows } from '../reports.js';
import { listChanges } from './changelog.js';
import { listBroadcasts, sendBroadcast } from './broadcasts.js';
import {
  ackByToken, ackInApp, ackPage, createDecision, decisionByToken, decisionDetail, decisionFilesTick, decisionPdf, deleteDecision,
  issueDecision, listDecisions, renderDecision, resendFiles, updateDecision,
} from './decisions.js';
import { chatMessages, chatPeople, chatRetentionTick, listChats, sendMessage, startChat, unreadTotal } from './chat.js';
import { addShortage, cancelShortage, listShortages, shortageDailyTick, shortageImage, supplyShortage, updateShortage } from './shortages.js';
import { decideCorrection, listCorrections, profile, requestCorrection } from './profile.js';
import {
  addDebt, addNote, decideDeduction, delegates, financeOverview, listDeductionRequests, listNotes, recordDeduction, setDelegate,
} from './finance.js';
import {
  additionSettings, decideCase, deleteException, listCases, listExceptions, reviewTick, saveAdditionSettings, saveException,
} from './cases.js';
import { PAGE_HEADERS, isFinance, people, requireFinance, requireSup } from './util.js';

/** Jobs run once a minute by the notifier. */
export const additionJobs = [decisionFilesTick, shortageDailyTick, chatRetentionTick, reviewTick];

export function registerAdditions(r, db) {
  const body = async (req) => parseJson(await readBody(req));
  const auth = { auth: true };
  const page = { auth: true, page: true };

  // ---------------------------------------------------------- change log
  r.get('/api/changes', ({ url, user }) => listChanges(db, user, {
    area: url.searchParams.get('area') || '', userId: Number(url.searchParams.get('user_id')) || null,
    from: url.searchParams.get('from'), to: url.searchParams.get('to'),
  }), auth);

  // ---------------------------------------------------------- custom WhatsApp messages
  r.get('/api/broadcasts', ({ user }) => listBroadcasts(db, user), auth);
  r.post('/api/broadcasts', async ({ req, user }) => sendBroadcast(db, user, await body(req)), auth);

  // ---------------------------------------------------------- decisions
  r.get('/api/decisions', ({ user }) => listDecisions(db, user), auth);
  r.post('/api/decisions', async ({ req, user }) => createDecision(db, user, await body(req)), auth);
  r.get('/api/decisions/:id', ({ params, user }) => decisionDetail(db, user, params.id), auth);
  r.put('/api/decisions/:id', async ({ req, params, user }) => updateDecision(db, user, params.id, await body(req)), auth);
  r.delete('/api/decisions/:id', ({ params, user }) => deleteDecision(db, user, params.id), auth);
  r.post('/api/decisions/:id/issue', async ({ req, params, user }) => issueDecision(db, user, params.id, await body(req)), auth);
  r.post('/api/decisions/:id/resend', async ({ req, params, user }) => resendFiles(db, user, params.id, await body(req)), auth);
  r.post('/api/my/decisions/:id/ack', ({ params, user }) => ackInApp(db, user, params.id), auth);
  r.get('/decision/:id', ({ params, res, user }) => {
    requireSup(user);
    send(res, 200, renderDecision(decisionDetail(db, user, params.id).decision), PAGE_HEADERS);
  }, page);
  r.get('/decision/:id/pdf', async ({ params, res, user }) => {
    requireSup(user);
    const d = decisionDetail(db, user, params.id).decision;
    let pdf;
    try { pdf = await decisionPdf(d); } catch (e) { console.error('decision pdf', e.message); throw new HttpError(503, 'تعذّر إنشاء PDF الآن'); }
    send(res, 200, pdf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="decision-${d.id}.pdf"` });
  }, page);
  // the link in the WhatsApp message: read and acknowledge, no login needed (the token is the key)
  r.get('/ack/:token', ({ params, res }) => {
    const html = ackPage(db, params.token);
    if (!html) throw new HttpError(404, 'الرابط غير صحيح');
    send(res, 200, html, PAGE_HEADERS);
  });
  r.post('/ack/:token', ({ params, res }) => {
    if (!ackByToken(db, params.token)) throw new HttpError(404, 'الرابط غير صحيح');
    res.writeHead(303, { Location: `/ack/${encodeURIComponent(params.token)}` });
    res.end();
  });
  r.get('/ack/:token/pdf', async ({ params, res }) => {
    const d = decisionByToken(db, params.token);
    if (!d) throw new HttpError(404, 'الرابط غير صحيح');
    let pdf;
    try { pdf = await decisionPdf(d); } catch (e) { console.error('decision pdf', e.message); throw new HttpError(503, 'تعذّر إنشاء PDF الآن'); }
    send(res, 200, pdf, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="decision.pdf"' });
  });

  // ---------------------------------------------------------- chat
  r.get('/api/chat', ({ url, user }) => listChats(db, user, { all: url.searchParams.get('all') === '1' }), auth);
  r.get('/api/chat/unread', ({ user }) => ({ unread: unreadTotal(db, user) }), auth);
  r.get('/api/chat/people', ({ user }) => chatPeople(db, user), auth);
  r.post('/api/chat', async ({ req, user }) => startChat(db, user, await body(req)), auth);
  r.get('/api/chat/:id', ({ url, params, user }) => chatMessages(db, user, params.id, { after: url.searchParams.get('after') }), auth);
  r.post('/api/chat/:id', async ({ req, params, user }) => sendMessage(db, user, params.id, await body(req)), auth);

  // ---------------------------------------------------------- out-of-stock products
  r.get('/api/shortages', ({ url, user }) => listShortages(db, user, { status: url.searchParams.get('status') || 'active' }), auth);
  r.post('/api/shortages', async ({ req, user }) => addShortage(db, user, await body(req)), auth);
  r.put('/api/shortages/:id', async ({ req, params, user }) => updateShortage(db, user, params.id, await body(req)), auth);
  r.post('/api/shortages/:id/supply', async ({ req, params, user }) => supplyShortage(db, user, params.id, await body(req)), auth);
  r.post('/api/shortages/:id/cancel', async ({ req, params, user }) => cancelShortage(db, user, params.id, await body(req)), auth);
  r.get('/shortage-image/:id', ({ params, res, user }) => {
    const img = shortageImage(db, user, params.id);
    send(res, 200, img.buf, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  }, page);

  // ---------------------------------------------------------- profile & corrections
  r.get('/api/profile', ({ url, user }) => profile(db, user, { userId: url.searchParams.get('user_id'), month: url.searchParams.get('month') }), auth);
  r.get('/api/profile/people', ({ user }) => {
    if (user.role !== 'admin' && !user.perms.includes('supervisor') && !isFinance(user)) throw new HttpError(403, 'غير مسموح');
    return { people: people(db).filter((p) => p.role === 'employee') };
  }, auth);
  r.get('/api/corrections', ({ url, user }) => listCorrections(db, user, { status: url.searchParams.get('status') || 'pending' }), auth);
  r.post('/api/corrections', async ({ req, user }) => requestCorrection(db, user, await body(req)), auth);
  r.put('/api/corrections/:id', async ({ req, params, user }) => decideCorrection(db, user, params.id, await body(req)), auth);

  // ---------------------------------------------------------- finance, delegated deductions, notes
  r.get('/api/finance', ({ url, user }) => financeOverview(db, user, { month: url.searchParams.get('month') }), auth);
  r.post('/api/finance/debts', async ({ req, user }) => addDebt(db, user, await body(req)), auth);
  r.get('/finance/payslip', ({ url, res, user }) => {
    requireFinance(user);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : localDate().slice(0, 7);
    const userId = Number(url.searchParams.get('user_id'));
    const { rows, closed } = payrollFor(db, month);
    const row = rows.find((x) => x.userId === userId);
    if (!row) throw new HttpError(404, 'لا توجد قسيمة');
    const { from, to } = monthBounds(month);
    send(res, 200, renderPayslip({ month, row, closed, deductions: deductionRows(db, from, to, userId), debts: debtRows(db, userId).filter((d) => d.date >= from && d.date <= to) }), PAGE_HEADERS);
  }, page);
  r.get('/api/delegates', ({ user }) => { requireSup(user); return { delegates: delegates(db), people: people(db).filter((p) => p.role === 'employee') }; }, auth);
  r.put('/api/delegates', async ({ req, user }) => setDelegate(db, user, await body(req)), auth);
  r.get('/api/deduction-requests', ({ url, user }) => listDeductionRequests(db, user, { status: url.searchParams.get('status') || 'pending' }), auth);
  r.post('/api/deduction-requests', async ({ req, user }) => recordDeduction(db, user, await body(req)), auth);
  r.put('/api/deduction-requests/:id', async ({ req, params, user }) => decideDeduction(db, user, params.id, await body(req)), auth);
  r.get('/api/notes', ({ url, user }) => listNotes(db, user, { userId: url.searchParams.get('user_id') }), auth);
  r.post('/api/notes', async ({ req, user }) => addNote(db, user, await body(req)), auth);

  // ---------------------------------------------------------- review cases, shift exceptions, settings
  r.get('/api/cases', ({ url, user }) => listCases(db, user, { status: url.searchParams.get('status') || 'pending', userId: url.searchParams.get('user_id') }), auth);
  r.put('/api/cases/:id', async ({ req, params, user }) => decideCase(db, user, params.id, await body(req)), auth);
  r.get('/api/shift-exceptions', ({ url, user }) => listExceptions(db, user, { from: url.searchParams.get('from') }), auth);
  r.post('/api/shift-exceptions', async ({ req, user }) => saveException(db, user, await body(req)), auth);
  r.delete('/api/shift-exceptions/:id', async ({ req, params, user }) => deleteException(db, user, params.id, await body(req)), auth);
  r.get('/api/addition-settings', ({ user }) => additionSettings(db, user), auth);
  r.put('/api/addition-settings', async ({ req, user }) => saveAdditionSettings(db, user, await body(req)), auth);
  r.get('/api/staff-names', ({ user }) => ({ people: people(db).filter((p) => p.role === 'employee' && p.id !== user.id) }), auth);
}
