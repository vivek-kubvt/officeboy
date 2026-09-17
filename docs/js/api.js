// Talks to the office's Apps Script web app and remembers who this device belongs to.

const KEY = 'officeboy.session';
let memory = null; // fallback when localStorage is blocked

export const session = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch {
      return memory;
    }
  },
  set(value) {
    memory = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
    } catch {}
  },
  update(patch) {
    const current = session.get();
    if (current) session.set({ ...current, ...patch });
  },
  clear() {
    memory = null;
    try {
      localStorage.removeItem(KEY);
    } catch {}
  },
};

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** backend = { id, domain? } for Google, or { url } for the local mock server. */
export function backendUrl(backend) {
  if (backend.url) return backend.url;
  return backend.domain
    ? `https://script.google.com/a/macros/${encodeURIComponent(backend.domain)}/s/${encodeURIComponent(backend.id)}/exec`
    : `https://script.google.com/macros/s/${encodeURIComponent(backend.id)}/exec`;
}

export function parseBackendUrl(text) {
  const s = String(text || '').trim();
  let m = s.match(/script\.google\.com\/a\/macros\/([^/]+)\/s\/([\w-]+)/);
  if (m) return { id: m[2], domain: decodeURIComponent(m[1]) };
  m = s.match(/script\.google\.com\/macros\/s\/([\w-]+)/);
  if (m) return { id: m[1] };
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/exec$/.test(s)) return { url: s };
  return null;
}

export function inviteLink(backend, token) {
  const params = new URLSearchParams();
  if (backend.url) params.set('u', backend.url);
  else {
    params.set('s', backend.id);
    if (backend.domain) params.set('d', backend.domain);
  }
  params.set('t', token);
  return `${location.origin}${location.pathname}#/j?${params}`;
}

export function parseInviteLink(text) {
  const s = String(text || '').trim();
  const i = s.indexOf('#/j?');
  if (i < 0) return null;
  const p = new URLSearchParams(s.slice(i + 4));
  const token = p.get('t');
  let backend = null;
  if (p.get('u')) backend = parseBackendUrl(p.get('u'));
  else if (p.get('s')) backend = p.get('d') ? { id: p.get('s'), domain: p.get('d') } : { id: p.get('s') };
  return token && backend ? { token, backend } : null;
}

export async function call(backend, action, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    // text/plain keeps this a "simple" request, so Apps Script doesn't need to answer a CORS preflight.
    response = await fetch(backendUrl(backend), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('The office sheet is taking too long. Try again.', 'network');
    throw new ApiError(navigator.onLine === false ? 'You’re offline. Connect to the internet and try again.' : 'Can’t reach the office sheet. Check your internet and try again.', 'network');
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('The office sheet didn’t answer correctly. Check that the web app is deployed with access “Anyone”.', 'bad-response');
  }
  if (!body.ok) throw new ApiError(body.error || 'Something went wrong.', body.code);
  return body.data;
}

/** Call as the person signed in on this device. */
export function api(action, payload = {}) {
  const s = session.get();
  if (!s) return Promise.reject(new ApiError('Not signed in.', 'auth'));
  return call(s.backend, action, { ...payload, token: s.token });
}
