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

const authDir = () => process.env.WHATSAPP_AUTH_DIR || join(dirname(config.dbPath), 'wa-auth');

export const waStatus = () => ({ status: wa.status, me: wa.me, error: wa.error });
export const waConnected = () => wa.status === 'connected' && !!sock;
export const waQrSvg = () => (wa.qr ? QR.toString(wa.qr, { type: 'svg', margin: 1, color: { dark: '#17131f', light: '#ffffff' } }) : Promise.resolve(null));
export const waHasSession = () => existsSync(join(authDir(), 'creds.json'));

export async function waStart() {
  if (sock || starting) return;
  starting = true;
  stopped = false;
  try {
    B ??= await import('@whiskeysockets/baileys');
    const pino = (await import('pino')).default;
    await mkdir(authDir(), { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(authDir());
    let version;
    try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* use the bundled version */ }
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
    s.ev.on('creds.update', saveCreds);
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
        retries++;
        setTimeout(() => waStart().catch((e) => { wa.error = e.message; }), Math.min(60_000, 1500 * 2 ** Math.min(retries, 5)));
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
  await sock.sendMessage(hit.jid, { text });
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
