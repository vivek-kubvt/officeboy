import { call, session, parseBackendUrl, parseInviteLink } from '../api.js';
import { h, withBusy, errorText, toast } from '../ui.js';
import { SETUP_GUIDE_URL } from '../config.js';

function page(...children) {
  return h('main', { class: 'main no-nav' }, children);
}

function hero(title, subtitle) {
  return h('div', { class: 'hero' },
    h('img', { src: 'icons/icon-192.png', alt: '' }),
    h('h1', {}, title),
    subtitle && h('p', { class: 'muted' }, subtitle),
  );
}

function errorBox() {
  return h('div', { class: 'notice error', role: 'alert', hidden: true });
}

function showError(box, err) {
  box.textContent = errorText(err);
  box.hidden = false;
}

export function renderWelcome(root, { navigate }) {
  const input = h('input', { class: 'input', placeholder: 'Paste your OfficeBoy link', autocomplete: 'off', inputmode: 'url' });
  const error = errorBox();
  const open = () => {
    const invite = parseInviteLink(input.value);
    if (!invite) return showError(error, { message: 'That doesn’t look like an OfficeBoy link. Copy the whole link from your admin’s message.' });
    location.href = `${location.pathname}${input.value.slice(input.value.indexOf('#/j?'))}`;
  };

  root.append(page(
    hero('OfficeBoy', 'Tea and coffee orders for your office.'),
    h('section', { class: 'card' },
      h('h2', {}, 'Got a link from your admin?'),
      h('p', { class: 'muted small' }, 'Open the link from your WhatsApp, Slack or email message. If this app opened without it, paste the link here once.'),
      input,
      error,
      h('button', { class: 'btn primary block', onclick: open }, 'Open my link'),
    ),
    h('section', { class: 'card flat' },
      h('h2', {}, 'Admin'),
      h('p', { class: 'muted small' }, 'Set up OfficeBoy for your office with your own Google Sheet, or log back in on a new device.'),
      h('button', { class: 'btn block', onclick: () => navigate('setup') }, 'Set up or log in as admin'),
    ),
  ));
}

export function renderSetup(root, { navigate, route }) {
  let saved = '';
  try { saved = localStorage.getItem('officeboy.lastBackend') || ''; } catch {}
  const state = { backend: null, status: null };
  const body = h('div', { class: 'stack' });

  const stepUrl = () => {
    const input = h('input', { class: 'input', placeholder: 'https://script.google.com/macros/s/…/exec', value: saved, autocomplete: 'off', inputmode: 'url' });
    const error = errorBox();
    const next = h('button', { class: 'btn primary block', type: 'submit' }, 'Continue');
    const form = h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        error.hidden = true;
        const backend = parseBackendUrl(input.value);
        if (!backend) return showError(error, { message: 'Paste the web app URL from Apps Script. It ends with /exec.' });
        withBusy(next, async () => {
          try {
            state.status = await call(backend, 'status');
            state.backend = backend;
            try { localStorage.setItem('officeboy.lastBackend', input.value.trim()); } catch {}
            state.status.configured ? stepLogin() : stepCreate();
          } catch (err) {
            showError(error, err);
          }
        });
      },
    },
      h('h2', {}, '1. Connect your Google Sheet'),
      h('ol', { class: 'steps muted' },
        h('li', {}, 'Create a blank Google Sheet.'),
        h('li', {}, 'Open Extensions → Apps Script and paste in ', h('code', {}, 'Code.gs'), ' from the repo.'),
        h('li', {}, 'Run the ', h('code', {}, 'install'), ' function once and allow access.'),
        h('li', {}, 'Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.'),
        h('li', {}, 'Copy the web app URL and paste it below.'),
      ),
      SETUP_GUIDE_URL && h('a', { href: SETUP_GUIDE_URL, target: '_blank', rel: 'noopener', class: 'small' }, 'Step-by-step setup guide'),
      h('label', { class: 'field' }, h('span', {}, 'Web app URL'), input),
      error,
      next,
    );
    body.replaceChildren(form);
  };

  const finish = async (token) => {
    session.set({ backend: state.backend, token });
    history.replaceState(null, '', `${location.pathname}#/people`);
    route();
  };

  const stepCreate = () => {
    const office = h('input', { class: 'input', required: true, maxlength: 60, placeholder: 'e.g. Acme Pune office' });
    const name = h('input', { class: 'input', required: true, maxlength: 60, placeholder: 'Your name', autocomplete: 'name' });
    const pass = h('input', { class: 'input', type: 'password', required: true, minlength: 6, autocomplete: 'new-password' });
    const pass2 = h('input', { class: 'input', type: 'password', required: true, minlength: 6, autocomplete: 'new-password' });
    const error = errorBox();
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Create office');
    body.replaceChildren(h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        error.hidden = true;
        if (pass.value !== pass2.value) return showError(error, { message: 'The two passwords don’t match.' });
        withBusy(submit, async () => {
          try {
            const { token } = await call(state.backend, 'setup', { officeName: office.value, adminName: name.value, password: pass.value });
            toast('Office created');
            await finish(token);
          } catch (err) {
            showError(error, err);
          }
        });
      },
    },
      h('h2', {}, '2. Create your office'),
      h('p', { class: 'muted small' }, 'The admin password lets you log in on another device. Everyone else signs in with the personal link you share with them.'),
      h('label', { class: 'field' }, h('span', {}, 'Office name'), office),
      h('label', { class: 'field' }, h('span', {}, 'Your name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Admin password (6+ characters)'), pass),
      h('label', { class: 'field' }, h('span', {}, 'Repeat password'), pass2),
      error,
      submit,
      h('button', { class: 'btn ghost', type: 'button', onclick: stepUrl }, 'Use a different sheet'),
    ));
  };

  const stepLogin = () => {
    const pass = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'current-password' });
    const error = errorBox();
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Log in');
    body.replaceChildren(h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        error.hidden = true;
        withBusy(submit, async () => {
          try {
            const { token } = await call(state.backend, 'adminLogin', { password: pass.value });
            await finish(token);
          } catch (err) {
            showError(error, err);
          }
        });
      },
    },
      h('h2', {}, `Log in to ${state.status.officeName || 'your office'}`),
      h('p', { class: 'muted small' }, 'This sheet is already set up. Enter the admin password.'),
      h('label', { class: 'field' }, h('span', {}, 'Admin password'), pass),
      error,
      submit,
      h('button', { class: 'btn ghost', type: 'button', onclick: stepUrl }, 'Use a different sheet'),
    ));
  };

  root.append(page(
    hero('Set up OfficeBoy', 'Your data stays in your own Google Sheet.'),
    body,
    h('button', { class: 'btn ghost', onclick: () => navigate('') }, 'Back'),
  ));
  stepUrl();
}

export function renderLinkProblem(root, { message, retry, navigate }) {
  root.append(page(
    hero('Can’t open OfficeBoy', null),
    h('section', { class: 'card' },
      h('p', {}, message),
      retry && h('button', { class: 'btn primary block', onclick: retry }, 'Try again'),
      h('button', { class: 'btn block', onclick: () => { history.replaceState(null, '', location.pathname + '#/'); navigate(''); } }, 'Paste a different link'),
    ),
  ));
}

export function renderSwitchAccount(root, { currentName, onSwitch, onKeep }) {
  root.append(page(
    hero('Switch person?', null),
    h('section', { class: 'card' },
      h('p', {}, `This device is signed in as ${currentName || 'someone else'}. Open the new link instead?`),
      h('button', { class: 'btn primary block', onclick: onSwitch }, 'Use the new link'),
      h('button', { class: 'btn block', onclick: onKeep }, `Stay as ${currentName || 'current person'}`),
    ),
  ));
}
