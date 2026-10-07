// The manager answers requests straight from WhatsApp:
//   موافق ف12        approve release/shortage request 12
//   رفض ف12 السبب    reject it, with a reason
//   تم ف12           mark it done
//   موافق ج3 / رفض ج3 السبب   leave or permission request 3
//   طلبات            what's waiting
import { getSettings } from './settings.js';
import { normalizePhone } from './notify.js';
import { decideLeave, decideRequest } from './decisions.js';
import * as msg from './messages.js';

const DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const VERBS = [
  [/^(موافق|موافقه|موافقة|اوافق|أوافق|قبول|اعتماد|اعتمد|ok)$/i, 'approved'],
  [/^(رفض|ارفض|أرفض|مرفوض|لا)$/i, 'rejected'],
  [/^(تم|نفذ|نُفذ|منفذ|تنفيذ|خلص)$/i, 'done'],
];

/** Returns { status, target: 'request'|'leave', id, reason } or { help: true } or null. */
export function parseCommand(raw) {
  const t = String(raw || '').replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]).replace(/[*_~]/g, '').trim();
  if (/^(طلبات|الطلبات|مساعدة|اوامر|أوامر)$/.test(t)) return { help: true };
  const m = t.match(/^(\S+)\s*([فجFfJj])\s*#?\s*(\d{1,7})\s*[:،,.\-]?\s*([\s\S]*)$/);
  if (!m) return null;
  const verb = VERBS.find(([re]) => re.test(m[1]));
  if (!verb) return null;
  const target = /[فFf]/.test(m[2]) ? 'request' : 'leave';
  if (target === 'leave' && verb[1] === 'done') return null;
  return { status: verb[1], target, id: Number(m[3]), reason: m[4].trim().slice(0, 500) };
}

function pending(db) {
  const reqs = db.prepare("SELECT q.id, q.kind, q.sku, q.quantity, u.name FROM requests q JOIN users u ON u.id = q.user_id WHERE q.status = 'pending' ORDER BY q.id LIMIT 15").all();
  const leaves = db.prepare("SELECT l.*, u.name FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.status = 'pending' ORDER BY l.id LIMIT 15").all();
  return msg.pendingList({ reqs, leaves });
}

/**
 * Handles one incoming WhatsApp text. Only the manager's number is listened to; everything else is ignored (null).
 * Returns the reply to send back.
 */
export function handleIncoming(db, phone, text) {
  const s = getSettings(db);
  const manager = normalizePhone(s.notify.manager_phone);
  if (!manager || normalizePhone(phone) !== manager) return null;
  const cmd = parseCommand(text);
  if (!cmd) return null;
  if (cmd.help) return pending(db);
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  try {
    if (cmd.target === 'request') {
      const { request } = decideRequest(db, admin, cmd.id, cmd.status, cmd.reason || undefined);
      return msg.commandDone({ what: `طلب ${request.kind === 'release' ? 'الفسح' : 'النواقص'} رقم ${cmd.id}`, status: cmd.status, name: request.user_name, detail: `${request.sku} × ${request.quantity}` });
    }
    const { leave } = decideLeave(db, admin, cmd.id, cmd.status, cmd.reason || undefined);
    const name = db.prepare('SELECT name FROM users WHERE id = ?').get(leave.user_id)?.name || '';
    return msg.commandDone({ what: `${msg.LEAVE_KINDS[leave.kind]} رقم ${cmd.id}`, status: cmd.status, name, detail: msg.leaveWhen(leave) });
  } catch (e) {
    return msg.commandFailed({ reason: e.message });
  }
}
