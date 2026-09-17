import { api, session, parseInviteLink } from './api.js';
import { h, icon, loading, errorText } from './ui.js';
import { renderWelcome, renderSetup, renderLinkProblem, renderSwitchAccount } from './views/start.js';
import { renderToday } from './views/today.js';
import { renderBoard, renderHistory } from './views/board.js';
import { renderPeople, renderReports, renderSettings } from './views/admin.js';

const TABS = {
  employee: [{ id: 'today', label: 'Today', icon: 'cup', render: renderToday }],
  officeboy: [
    { id: 'board', label: 'Live', icon: 'list', render: renderBoard },
    { id: 'history', label: 'History', icon: 'calendar', render: renderHistory, when: (f) => f?.officeBoyHistory !== false },
  ],
  admin: [
    { id: 'board', label: 'Live', icon: 'list', render: renderBoard },
    { id: 'today', label: 'My drink', icon: 'cup', render: renderToday },
    { id: 'people', label: 'People', icon: 'users', render: renderPeople },
    { id: 'reports', label: 'Reports', icon: 'chart', render: renderReports },
    { id: 'settings', label: 'Settings', icon: 'gear', render: renderSettings },
  ],
};

const root = document.getElementById('app');
let cleanup = null;
let installPrompt = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path] = raw.split('?');
  return path;
}

export function navigate(path) {
  if (parseHash() === path) route();
  else location.hash = `#/${path}`;
}

async function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  const path = parseHash();

  if (path === 'j') return join();
  if (path === 'setup') return mount(renderSetup);

  const s = session.get();
  if (!s) return mount(renderWelcome);
  if (!s.role) return join(true);
  showShell(s, path);
}

/** Opening a personal link: remember it on this device, then show that person's home. */
async function join(fromSession = false) {
  const current = session.get();
  const invite = fromSession ? { token: current.token, backend: current.backend } : parseInviteLink(location.href);
  if (!invite) return mount(renderLinkProblem, { message: 'This link is incomplete. Copy the full link from your admin’s message.' });

  if (!fromSession && current && current.token !== invite.token && !sessionStorage.getItem(`ob.switch.${invite.token}`)) {
    return mount(renderSwitchAccount, {
      currentName: current.name,
      onSwitch: () => {
        sessionStorage.setItem(`ob.switch.${invite.token}`, '1');
        route();
      },
      onKeep: () => {
        history.replaceState(null, '', location.pathname + '#/');
        route();
      },
    });
  }

  root.replaceChildren(loading());
  const previous = current;
  session.set({ backend: invite.backend, token: invite.token });
  try {
    const me = await api('me');
    session.set({ backend: invite.backend, token: invite.token, role: me.user.role, name: me.user.name, officeName: me.officeName, features: me.features });
    showShell(session.get(), fromSession ? parseHash() : TABS[me.user.role][0].id);
  } catch (err) {
    if (err.code === 'auth') {
      if (previous && previous.token !== invite.token) session.set(previous);
      else session.clear();
      return mount(renderLinkProblem, { message: errorText(err) });
    }
    // Offline or sheet unreachable: keep the link so it works once the network is back.
    if (previous && previous.token !== invite.token && !previous.role) session.set(previous);
    mount(renderLinkProblem, { message: errorText(err), retry: () => route() });
  }
}

function showShell(s, path) {
  const tabs = (TABS[s.role] || TABS.employee).filter((t) => !t.when || t.when(s.features));
  const tab = tabs.find((t) => t.id === path) || tabs[0];
  const wide = ['people', 'reports', 'settings'].includes(tab.id);

  const main = h('main', { class: `main${wide ? ' wide' : ''}${tabs.length < 2 ? ' no-nav' : ''}` }, loading());
  const installBtn = h('button', { class: 'btn sm', hidden: !installPrompt, onclick: install }, 'Install');
  const topbar = h('header', { class: 'topbar' },
    h('img', { src: 'icons/icon-192.png', alt: '' }),
    h('div', { class: 'title' },
      h('strong', {}, s.officeName || 'OfficeBoy'),
      h('span', {}, s.name ? `${s.name} · ${roleName(s.role)}` : roleName(s.role)),
    ),
    installBtn,
  );
  const nav = tabs.length > 1
    ? h('nav', { class: 'bottomnav', 'aria-label': 'Sections' },
      tabs.map((t) => h('a', { href: `#/${t.id}`, 'aria-current': t.id === tab.id ? 'page' : null }, icon(t.icon), t.label)))
    : null;

  root.replaceChildren(h('div', { class: 'app' }, topbar, main, nav));
  document.title = `${tab.label} · OfficeBoy`;
  window.scrollTo(0, 0);

  const onSession = (me) => {
    // Keep header and role in sync with the sheet (admin may rename or change someone's role).
    const now = session.get();
    if (!now || !me?.user) return;
    const changedLayout = me.user.role !== now.role || JSON.stringify(me.features) !== JSON.stringify(now.features);
    session.update({ name: me.user.name, role: me.user.role, officeName: me.officeName, features: me.features });
    if (changedLayout) route();
    else topbar.querySelector('.title').replaceChildren(h('strong', {}, me.officeName || 'OfficeBoy'), h('span', {}, `${me.user.name} · ${roleName(me.user.role)}`));
  };

  const result = tab.render(main, { session: s, onSession, onAuthError: handleAuthError, navigate });
  Promise.resolve(result).then((fn) => {
    if (typeof fn === 'function') cleanup = fn;
  });

  if (tab.render !== renderToday) api('me').then(onSession).catch(handleAuthError);
}

function handleAuthError(err) {
  if (err?.code === 'auth') {
    session.clear();
    mount(renderLinkProblem, { message: errorText(err) });
    return true;
  }
  if (err?.code === 'role') {
    session.update({ role: null });
    route();
    return true;
  }
  return false;
}

function mount(render, props = {}) {
  root.replaceChildren();
  const result = render(root, { ...props, navigate, route });
  Promise.resolve(result).then((fn) => {
    if (typeof fn === 'function') cleanup = fn;
  });
}

export function roleName(role) {
  return { admin: 'Admin', employee: 'Employee', officeboy: 'Office boy' }[role] || '';
}

async function install() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.querySelectorAll('.topbar .btn').forEach((b) => (b.hidden = true));
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.querySelectorAll('.topbar .btn').forEach((b) => (b.hidden = false));
});
window.addEventListener('hashchange', route);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

route();
