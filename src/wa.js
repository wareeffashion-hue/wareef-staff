// Direct WhatsApp link (QR, like WhatsApp Web) using Baileys. The session lives next to the
// database (/data/wa-auth) so it survives restarts and redeploys; scanning once is enough.
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import QR from 'qrcode';
import { config } from './config.js';

const wa = { status: 'off', qr: null, me: null, error: null };
let B = null;
let sock = null;
let starting = false;
let retries = 0;
let stopped = false;
let onIncoming = null;
const sentIds = new Set();
const remember = (m) => { if (m?.key?.id) { sentIds.add(m.key.id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); } };

/** `handler(phone, text)` gets every incoming text and may return a reply. */
export function waOnMessage(handler) { onIncoming = handler; }

/** The phone number behind a message key. Baileys 7 may address chats by LID; the phone then sits in the *Alt / senderPn fields. */
export function phoneOfKey(key = {}) {
  for (const j of [key.remoteJidAlt, key.senderPn, key.participantAlt, key.remoteJid]) {
    if (typeof j === 'string' && j.endsWith('@s.whatsapp.net')) return j.split('@')[0].split(':')[0];
  }
  return '';
}
export const textOf = (m) => m?.message?.conversation || m?.message?.extendedTextMessage?.text || '';

const authDir = () => process.env.WHATSAPP_AUTH_DIR || join(dirname(config.dbPath), 'wa-auth');

export const waStatus = () => ({ status: wa.status, me: wa.me, error: wa.error });
export const waConnected = () => wa.status === 'connected' && !!sock;
export const waQrSvg = () => (wa.qr ? QR.toString(wa.qr, { type: 'svg', margin: 1, color: { dark: '#17131f', light: '#ffffff' } }) : Promise.resolve(null));
export const waHasSession = () => existsSync(join(authDir(), 'creds.json'));

let waVersion = null;
/** Try again later; a failed restart schedules the next one instead of leaving WhatsApp off for good. */
function retryLater() {
  retries++;
  setTimeout(() => waStart().catch((e) => { wa.error = e.message; if (waHasSession() && !stopped) retryLater(); }), Math.min(60_000, 1500 * 2 ** Math.min(retries, 5))).unref?.();
}

/** Closing the app (a redeploy): end the socket cleanly so the saved login isn't cut mid-write. */
export function waShutdown() {
  stopped = true;
  try { sock?.end?.(undefined); } catch { /* closing anyway */ }
}

export async function waStart() {
  if (sock || starting) return;
  starting = true;
  stopped = false;
  try {
    B ??= await import('@whiskeysockets/baileys');
    const pino = (await import('pino')).default;
    await mkdir(authDir(), { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(authDir());
    // ask WhatsApp for the current protocol version once per run, not on every reconnect
    if (!waVersion) { try { ({ version: waVersion } = await B.fetchLatestBaileysVersion()); } catch { /* use the bundled version */ } }
    const version = waVersion;
    wa.status = 'connecting';
    const s = B.makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'silent' }),
      browser: B.Browsers.ubuntu('Wareef Team'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sock = s;
    s.ev.on('creds.update', () => saveCreds().catch((e) => console.error('whatsapp creds', e.message)));
    s.ev.on('messages.upsert', async ({ messages, type }) => {
      if (!onIncoming || (type !== 'notify' && type !== 'append')) return;
      for (const m of messages) {
        try {
          if (sentIds.has(m.key?.id)) continue;
          // Only fresh messages: never act on history that syncs after a reconnect.
          if (Date.now() / 1000 - Number(m.messageTimestamp || 0) > 300) continue;
          if (type === 'append' && !m.key?.fromMe) continue;
          if (String(m.key?.remoteJid || '').endsWith('@g.us')) continue; // commands only from a private chat, never a group
          const text = textOf(m).trim();
          if (!text) continue;
          const phone = phoneOfKey(m.key);
          // Writing to yourself ("message yourself" chat) when the manager linked their own number.
          if (m.key?.fromMe) {
            if (!wa.me || phone !== wa.me) continue;
          }
          if (!phone) continue;
          const reply = await onIncoming(phone, text);
          if (reply) remember(await s.sendMessage(m.key.remoteJid, { text: reply }));
        } catch (e) {
          console.error('whatsapp incoming', e.message);
        }
      }
    });
    s.ev.on('connection.update', (u) => {
      if (u.qr) { wa.qr = u.qr; wa.status = 'qr'; }
      if (u.connection === 'open') {
        wa.status = 'connected';
        wa.qr = null;
        wa.error = null;
        retries = 0;
        wa.me = String(s.user?.id || '').split(':')[0].split('@')[0] || null;
      }
      if (u.connection === 'close') {
        if (sock === s) sock = null;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === B.DisconnectReason.loggedOut || stopped) {
          wa.status = 'off';
          wa.me = null;
          wa.qr = null;
          if (code === B.DisconnectReason.loggedOut) rm(authDir(), { recursive: true, force: true }).catch(() => {});
          return;
        }
        // While waiting for a scan the QR expires every minute or so; reconnect to get a new one.
        wa.status = waHasSession() ? 'connecting' : 'qr';
        wa.error = u.lastDisconnect?.error?.message || null;
        // nobody scanned the code for a long while: stop asking until someone presses "ربط" again
        if (!waHasSession() && retries >= 15) { wa.status = 'off'; wa.qr = null; wa.error = 'انتهت مهلة مسح الرمز. اضغط ربط واتساب من جديد'; retries = 0; return; }
        retryLater();
      }
    });
  } catch (e) {
    sock = null;
    wa.status = 'off';
    wa.error = e.message;
    throw e;
  } finally {
    starting = false;
  }
}

export async function waSend(to, text) {
  if (!waConnected()) throw Object.assign(new Error('واتساب غير مربوط حالياً'), { defer: true });
  const [hit] = await sock.onWhatsApp(`${to}@s.whatsapp.net`);
  if (!hit?.exists) throw new Error(`الرقم ${to} غير مسجّل في واتساب`);
  remember(await sock.sendMessage(hit.jid, { text }));
}

export async function waSendDocument(to, buffer, fileName, caption = '', mimetype = 'application/vnd.sqlite3') {
  if (!waConnected()) throw Object.assign(new Error('واتساب غير مربوط حالياً'), { defer: true });
  const [hit] = await sock.onWhatsApp(`${to}@s.whatsapp.net`);
  if (!hit?.exists) throw new Error(`الرقم ${to} غير مسجّل في واتساب`);
  remember(await sock.sendMessage(hit.jid, { document: buffer, fileName, mimetype, caption }));
}

export async function waLogout() {
  stopped = true;
  const s = sock;
  sock = null;
  try { await s?.logout(); } catch { /* already gone */ }
  await rm(authDir(), { recursive: true, force: true });
  wa.status = 'off';
  wa.me = null;
  wa.qr = null;
}

/** On boot: reconnect automatically if a phone was linked before. */
export function waAutoStart() {
  if (waHasSession()) waStart().catch((e) => console.error('whatsapp', e.message));
}
