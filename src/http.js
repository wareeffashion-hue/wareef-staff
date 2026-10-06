// Small HTTP toolkit: router with :params, body parsing, cookies, JSON errors.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 5 * 1024 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export function send(res, status, body, headers = {}) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(raw ? body : JSON.stringify(body));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Client IP behind one trusted reverse proxy (Railway, Nginx, Cloudflare...).
 * The first X-Forwarded-For entry is whatever the client sent, so it can't be
 * trusted for rate limits; the proxy's own X-Real-IP or the last entry can.
 */
export function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket.remoteAddress || '';
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: r.handler, params, opts: r.opts };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/** Fixed-window in-memory rate limiter. */
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (key) => {
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n <= limit;
  };
}
