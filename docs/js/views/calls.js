// "Call office boy": the caller's card, and the office boy's ringing screen.

import { api, lastReply } from '../api.js';
import { h, fill, icon, toast, openSheet, withBusy, errorText, spinner } from '../ui.js';
import { enablePush, pushState, pushSupport } from '../push.js';
import { isIOS } from '../platform.js';

export const REASON_ICONS = { Tea: '☕', Coffee: '☕', Water: '💧', 'Come to cabin': '🚪', 'Clean up': '🧹', Snacks: '🍪' };

function ago(iso, offset = 0) {
  const mins = Math.max(0, Math.round((Date.now() + offset - new Date(iso).getTime()) / 60000));
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
}

function who(from) {
  return [from.title, from.desk].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ sound, vibration, screen awake

let audio = null;
let ringTimer = null;
let wakeLock = null;
const DUTY_KEY = 'officeboy.duty';

function readDuty() {
  try { return localStorage.getItem(DUTY_KEY) === '1'; } catch { return false; }
}
let onDuty = readDuty();

/** Browsers only allow sound after a tap, so call this from a click handler. */
function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const wasReady = soundReady();
  if (!audio) audio = new Ctx();
  if (audio.state === 'suspended') audio.resume();
  // Redraw after the tap has finished, so the button being tapped isn't replaced mid-click.
  if (!wasReady) setTimeout(() => soundReady() && notify(), 400);
}

function soundReady() {
  return !!audio && audio.state === 'running';
}

function beep(at, freq, length) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

function ringOnce() {
  navigator.vibrate?.([400, 150, 400, 150, 800]);
  if (!soundReady()) return;
  const t = audio.currentTime;
  [[0, 988], [0.18, 784], [0.36, 988], [0.54, 784], [1.1, 988], [1.28, 784], [1.46, 988], [1.64, 784]].forEach(([d, f]) => beep(t + d, f, 0.16));
}

function setRinging(on) {
  if (on && !ringTimer) {
    ringOnce();
    ringTimer = setInterval(ringOnce, 3000);
  } else if (!on && ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
    navigator.vibrate?.(0);
  }
}

async function keepAwake() {
  if (!onDuty || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {}
}

function startDuty() {
  unlockAudio();
  onDuty = true;
  try { localStorage.setItem(DUTY_KEY, '1'); } catch {}
  keepAwake();
  setTimeout(ringOnce, 150); // short test so he knows the volume
  notify();
}

function stopDuty() {
  onDuty = false;
  try { localStorage.removeItem(DUTY_KEY); } catch {}
  wakeLock?.release();
  wakeLock = null;
  notify();
}

// ------------------------------------------------------------------ office boy: watch calls every 5 s

const watch = { on: false, timer: null, version: null, calls: [], offset: 0, error: null, loading: false, busy: new Set(), onAuthError: null, firebase: undefined };
const subscribers = new Set();

function notify() {
  const open = watch.calls.filter((c) => c.status === 'open');
  setRinging(watch.on && open.length > 0);
  renderAlert(open);
  subscribers.forEach((fn) => fn());
}

const onVisible = () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    refresh();
  }
};

/** Turned on by the app shell while an office boy is signed in, on every tab. */
export function setCallWatcher(on, opts = {}) {
  if (opts.onAuthError) watch.onAuthError = opts.onAuthError;
  if (on === watch.on) return;
  watch.on = on;
  if (on) {
    refresh();
    keepAwake();
    watch.timer = setInterval(() => document.visibilityState === 'visible' && refresh(), 5000);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('pointerdown', unlockAudio, { passive: true });
  } else {
    clearInterval(watch.timer);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('pointerdown', unlockAudio);
    Object.assign(watch, { version: null, calls: [], error: null });
    notify();
  }
}

async function refresh() {
  if (watch.loading || watch.busy.size) return;
  watch.loading = true;
  const hadError = !!watch.error;
  let changed = !watch.version;
  try {
    const data = await api('calls', { since: watch.version });
    if (!data.unchanged) {
      watch.calls = data.calls;
      changed = true;
    }
    watch.version = data.version;
    watch.offset = data.serverNow - Date.now();
    watch.error = null;
  } catch (err) {
    if (watch.onAuthError?.(err)) return setCallWatcher(false);
    watch.error = err;
  } finally {
    watch.loading = false;
  }
  // Redraw only when something changed, so a tap in progress isn't lost.
  if (changed || hadError !== !!watch.error) notify();
}

async function setStatus(call, status) {
  if (watch.busy.has(call.id)) return;
  unlockAudio();
  watch.busy.add(call.id);
  call.status = status; // optimistic: stop ringing right away
  notify();
  try {
    const data = await api('updateCall', { id: call.id, status });
    watch.calls = data.calls;
    watch.version = data.version;
  } catch (err) {
    if (!watch.onAuthError?.(err)) toast(errorText(err), 'error');
    watch.version = null;
  } finally {
    watch.busy.delete(call.id);
    refresh();
  }
}

// Full-screen alert shown on top of any tab while a call is waiting.
let alertEl = null;
function renderAlert(open) {
  if (!open.length) {
    alertEl?.remove();
    alertEl = null;
    return;
  }
  if (!alertEl) {
    alertEl = h('div', { class: 'call-alert', role: 'alertdialog', 'aria-live': 'assertive' });
    document.body.append(alertEl);
  }
  fill(alertEl,
    h('div', { class: 'call-alert-inner' },
      h('div', { class: 'call-bell' }, icon('bell')),
      h('h1', {}, open.length === 1 ? 'New call' : `${open.length} new calls`),
      !soundReady() && h('button', { class: 'btn big block sound-btn', onclick: () => { unlockAudio(); ringOnce(); } }, '🔊 Tap to turn on sound'),
      open.slice(0, 3).map((c) => h('div', { class: 'call-alert-card' },
        h('div', { class: 'call-reason' }, `${REASON_ICONS[c.reason] || '🔔'} ${c.reason}`),
        c.note && h('div', { class: 'call-note' }, `“${c.note}”`),
        h('div', { class: 'call-from' }, c.from.name),
        who(c.from) && h('div', { class: 'call-where' }, who(c.from)),
        h('div', { class: 'tiny', style: 'opacity:.8' }, ago(c.createdAt, watch.offset)),
        h('button', {
          class: 'btn big block coming-btn', disabled: watch.busy.has(c.id),
          onclick: () => setStatus(c, 'coming'),
        }, watch.busy.has(c.id) ? spinner() : [icon('check'), 'I’m coming']),
      )),
      open.length > 3 && h('p', {}, `+ ${open.length - 3} more`),
    ),
  );
}

// ------------------------------------------------------------------ office boy: Calls tab

export async function renderCalls(main, { onAuthError }) {
  const draw = () => {
    const active = watch.calls.filter((c) => c.status === 'open' || c.status === 'coming');
    const finished = watch.calls.filter((c) => c.status === 'done' || c.status === 'cancelled');
    fill(main,
      h('div', {}, h('h1', {}, 'Calls'), h('p', { class: 'muted small' }, 'Managers call you from their phone. This screen rings.')),
      dutyCard(),
      pushCard(),
      watch.error && h('div', { class: 'notice' }, /Unknown action/.test(watch.error.message)
        ? 'Calls need the latest Apps Script. Ask your admin to update it.'
        : `Couldn’t refresh: ${errorText(watch.error)}`),
      h('div', { class: 'section-title' }, `Waiting (${active.length})`),
      active.length
        ? h('section', { class: 'card' }, active.map((c) => h('div', { class: 'call-row' },
          h('div', { class: 'call-emoji' }, REASON_ICONS[c.reason] || '🔔'),
          h('div', { class: 'grow' },
            h('div', { class: 'strong' }, `${c.reason} · ${c.from.name}`),
            h('div', { class: 'muted small' }, [who(c.from), ago(c.createdAt, watch.offset)].filter(Boolean).join(' · ')),
            c.note && h('div', { class: 'small' }, `“${c.note}”`),
          ),
          c.status === 'open'
            ? h('button', { class: 'btn sm primary', disabled: watch.busy.has(c.id), onclick: () => setStatus(c, 'coming') }, 'Coming')
            : h('button', { class: 'btn sm yes', 'aria-pressed': 'true', disabled: watch.busy.has(c.id), onclick: () => setStatus(c, 'done') }, icon('check'), 'Done'),
        )))
        : h('div', { class: 'card empty' }, watch.loading && !watch.version ? spinner() : 'No calls right now.'),
      finished.length > 0 && h('div', { class: 'section-title' }, 'Earlier today'),
      finished.length > 0 && h('section', { class: 'card flat' }, finished.map((c) => h('div', { class: 'call-row done' },
        h('div', { class: 'call-emoji' }, REASON_ICONS[c.reason] || '🔔'),
        h('div', { class: 'grow' },
          h('div', {}, `${c.reason} · ${c.from.name}`),
          h('div', { class: 'muted tiny' }, `${c.status === 'done' ? 'Done' : 'Cancelled'} · ${ago(c.updatedAt, watch.offset)}`),
        ),
      ))),
    );
  };

  function dutyCard() {
    if (onDuty && soundReady()) {
      return h('section', { class: 'card soft' },
        h('div', { class: 'row between' },
          h('div', {}, h('h2', {}, 'On duty ✓'), h('p', { class: 'small' }, 'Sound is on and the screen stays awake. Keep this app open.')),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => ringOnce() }, '🔊 Test sound'),
          h('button', { class: 'btn sm ghost', onclick: stopDuty }, 'Stop duty'),
        ),
        isIOS && h('p', { class: 'muted tiny' }, 'iPhone: keep the ring/silent switch on ring, or the sound is muted.'),
      );
    }
    return h('section', { class: 'card' },
      h('h2', {}, onDuty ? 'Turn the sound back on' : 'Start duty'),
      h('p', { class: 'muted small' }, onDuty
        ? 'The app was reopened, so the phone needs one tap before it can ring.'
        : 'Keep this phone or tablet open in the pantry. It rings loudly when someone calls, and the screen stays on.'),
      h('button', { class: 'btn primary big block', onclick: startDuty }, onDuty ? '🔊 Turn on sound' : '🔔 Start duty'),
    );
  }

  function pushCard() {
    if (watch.firebase === undefined) return null; // still loading
    if (!watch.firebase?.ready) {
      return h('p', { class: 'muted small' }, 'Phone notifications aren’t set up by your admin yet, so calls only ring while this app is open.');
    }
    const state = pushState();
    if (state === 'on') {
      return h('section', { class: 'card flat row between wrap' },
        h('div', {}, h('div', { class: 'strong' }, 'Phone notifications on ✓'), h('div', { class: 'muted small' }, 'You’ll be notified even when the app is closed.')),
        h('button', {
          class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => {
            try {
              const r = await api('testPush');
              toast(r.sent ? 'Test sent. Check your notifications.' : 'No notification sent. Turn notifications on again.', r.sent ? '' : 'error');
            } catch (err) { toast(errorText(err), 'error'); }
          }),
        }, 'Send test'),
      );
    }
    const note = state === 'unsupported' ? pushSupport().reason : state === 'blocked' ? 'Notifications are blocked for this app. Allow them in your phone’s settings, then come back.' : null;
    return h('section', { class: 'card' },
      h('div', {}, h('h2', {}, 'Get calls when the app is closed'), h('p', { class: 'muted small' }, 'Your phone shows a notification with sound for every call.')),
      note
        ? h('div', { class: 'notice' }, note)
        : h('button', {
          class: 'btn primary block', onclick: (e) => withBusy(e.currentTarget, async () => {
            try {
              await enablePush(watch.firebase);
              toast('Notifications are on');
              draw();
            } catch (err) { toast(errorText(err), 'error'); }
          }),
        }, icon('bell'), 'Turn on notifications'),
    );
  }

  subscribers.add(draw);
  draw();
  if (watch.firebase === undefined) {
    api('me').then((me) => { watch.firebase = me.firebase; draw(); }).catch((err) => onAuthError(err));
  }
  const tick = setInterval(draw, 30000); // keep "5 min ago" fresh
  return () => {
    subscribers.delete(draw);
    clearInterval(tick);
  };
}

// ------------------------------------------------------------------ caller: "Call office boy" card

const STATUS = {
  open: ['warn', 'Waiting…'],
  coming: ['ok', 'Coming'],
  done: ['', 'Done ✓'],
  cancelled: ['', 'Cancelled'],
};

/** Mounts into `slot` and keeps it updated. Returns a cleanup function. */
export function mountCallCard(slot, { features, onAuthError }) {
  let calls = [];
  let offset = 0;
  let stopped = false;

  async function load() {
    try {
      const data = await api('myCalls');
      calls = data.calls;
      offset = data.serverNow - Date.now();
      lastReply.set('myCalls', data);
    } catch (err) {
      if (onAuthError(err)) return;
    }
    draw();
  }

  async function place(reason) {
    let note = '';
    const go = await openSheet((close) => {
      const input = features.allowCallNote && h('input', { class: 'input', maxlength: 120, placeholder: 'Note (optional), e.g. 2 guests', oninput: (e) => { note = e.target.value; } });
      return [
        h('div', { class: 'row between' }, h('h2', {}, `${REASON_ICONS[reason] || '🔔'} Call for ${reason}?`), h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel')),
        h('p', { class: 'muted small' }, 'The office boy’s phone will ring.'),
        input,
        h('button', { class: 'btn primary big block', onclick: () => close(true) }, icon('bell'), 'Call now'),
      ];
    });
    if (!go) return;
    try {
      const data = await api('call', { reason, note });
      calls = data.calls;
      offset = data.serverNow - Date.now();
      toast(data.push?.sent ? 'Called. His phone is ringing.' : 'Called. He’ll see it on his screen.');
    } catch (err) {
      if (!onAuthError(err)) toast(errorText(err), 'error');
    }
    draw();
  }

  async function cancel(c, button) {
    await withBusy(button, async () => {
      try {
        calls = (await api('cancelCall', { id: c.id })).calls;
      } catch (err) {
        if (!onAuthError(err)) toast(errorText(err), 'error');
      }
    });
    draw();
  }

  function draw() {
    if (stopped) return;
    const recent = calls.filter((c) => c.status === 'open' || c.status === 'coming' || Date.now() + offset - new Date(c.updatedAt).getTime() < 10 * 60000);
    fill(slot,
      h('section', { class: 'card call-card' },
        h('div', {},
          h('h2', {}, 'Call office boy'),
          h('p', { class: 'muted small' }, 'Tap what you need. His phone rings.'),
        ),
        h('div', { class: 'reason-grid' }, features.callReasons.map((r) => h('button', { class: 'reason-btn', onclick: () => place(r) },
          h('span', { class: 'reason-emoji' }, REASON_ICONS[r] || '🔔'), r))),
        recent.length > 0 && h('div', { class: 'stack', style: 'gap:0' }, recent.map((c) => {
          const [tone, label] = STATUS[c.status] || ['', c.status];
          return h('div', { class: 'call-row' },
            h('div', { class: 'call-emoji' }, REASON_ICONS[c.reason] || '🔔'),
            h('div', { class: 'grow' },
              h('div', { class: 'strong' }, c.reason),
              h('div', { class: 'muted tiny' }, ago(c.createdAt, offset)),
            ),
            h('span', { class: `pill ${tone}` }, c.status === 'coming' && c.handledBy ? `${c.handledBy} is coming` : label),
            c.status === 'open' && h('button', { class: 'btn sm ghost', 'aria-label': 'Cancel call', onclick: (e) => cancel(c, e.currentTarget) }, icon('x')),
          );
        })),
      ),
    );
  }

  const saved = lastReply.get('myCalls');
  if (saved) {
    calls = saved.data.calls;
    offset = saved.offset;
  }
  draw();
  load();
  // Check every 6 s while a call is waiting, otherwise every 30 s.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    const waiting = calls.some((c) => c.status === 'open' || c.status === 'coming');
    if (document.visibilityState === 'visible' && (waiting || ticks % 5 === 0)) load();
  }, 6000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
