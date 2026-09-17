// Tiny DOM helpers. Everything user-provided goes through text nodes, never innerHTML.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value' || key === 'checked') el[key] = value;
    else if (key === 'html') el.innerHTML = value; // only for our own static SVG
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

/** Like el.replaceChildren, but skips false/null and flattens arrays (so `cond && node` works). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const PATHS = {
  cup: '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"/><path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M3 21h15"/><path d="M8 2.5c0 1 .8 1.3.8 2.3S8 6 8 6M12 2.5c0 1 .8 1.3.8 2.3S12 6 12 6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export function icon(name) {
  return h('span', {
    'aria-hidden': 'true',
    style: 'display:inline-flex',
    html: `<svg width="1.15em" height="1.15em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`,
  });
}

export function spinner() {
  return h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
}

export function loading() {
  return h('div', { class: 'loading' }, spinner());
}

let toastTimer;
export function toast(message, kind = '') {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2600);
}

/** Bottom sheet dialog. `build(close)` returns the content. Resolves with whatever close() gets. */
export function openSheet(build) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      previousFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, build(close));
    const backdrop = h('div', { class: 'backdrop', onclick: (e) => e.target === backdrop && close() }, sheet);
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    sheet.querySelector('input, button')?.focus({ preventScroll: true });
  });
}

export function confirmSheet({ title, message, confirm = 'Confirm', danger = false }) {
  return openSheet((close) => [
    h('h2', {}, title),
    h('p', { class: 'muted' }, message),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, confirm),
    ),
  ]);
}

/** Runs an async click handler with the button showing a spinner. */
export async function withBusy(button, fn) {
  if (button.disabled) return;
  const original = [...button.childNodes];
  button.disabled = true;
  button.replaceChildren(spinner());
  try {
    return await fn();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.replaceChildren(...original);
    }
  }
}

export function errorText(err) {
  return err?.message || 'Something went wrong.';
}

// ---------- formatting ----------

export function timeLabel(hhmm) {
  const [hours, minutes] = String(hhmm).split(':').map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateLabel(yyyyMmDd, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], opts);
}

export function untilLabel(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function drinkLabel(drink, sugar) {
  if (!drink) return '';
  if (!sugar) return drink;
  return `${drink} · ${sugar === 'No sugar' ? 'No sugar' : `${sugar} sugar`}`;
}

export function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Re-runs `fn` every `ms` while the page is visible, and right away when it becomes visible again. */
export function poll(fn, ms) {
  let timer = setInterval(() => document.visibilityState === 'visible' && fn(), ms);
  const onVisible = () => document.visibilityState === 'visible' && fn();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
