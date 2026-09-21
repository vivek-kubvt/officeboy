import { call, session, parseBackendUrl, parseInviteLink } from '../api.js';
import { h, icon, withBusy, errorText, toast } from '../ui.js';
import { isIOS, isAndroid, isInAppBrowser, isStandalone, canPromptInstall, promptInstall, onInstallChange, markInstalledHint, copyText } from '../platform.js';
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
  const openLink = (text) => {
    const invite = parseInviteLink(text);
    if (!invite) return showError(error, { message: 'That doesn’t look like an OfficeBoy link. Copy the whole link from your admin’s message.' });
    location.href = `${location.pathname}${text.trim().slice(text.trim().indexOf('#/j?'))}`;
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      input.value = text;
      openLink(text);
    } catch {
      input.focus();
      showError(error, { message: 'Couldn’t read the clipboard. Long-press the box above and tap Paste.' });
    }
  };
  const installed = isStandalone();

  root.append(page(
    hero(installed ? 'Welcome to OfficeBoy' : 'OfficeBoy', installed ? 'One last step: paste the link you copied.' : 'Tea and coffee orders for your office.'),
    h('section', { class: 'card' },
      h('h2', {}, installed ? 'Paste your link' : 'Got a link from your admin?'),
      h('p', { class: 'muted small' }, installed
        ? 'You only need to do this once. Your link is still on the clipboard if you tapped “Copy my link”. If not, copy it again from your admin’s message.'
        : 'Open the link from your WhatsApp, Slack or email message. If this app opened without it, paste the link here once.'),
      navigator.clipboard?.readText && h('button', { class: 'btn primary big block', onclick: paste }, icon('copy'), 'Paste my link'),
      input,
      error,
      h('button', { class: `btn ${navigator.clipboard?.readText ? '' : 'primary '}block`, onclick: () => openLink(input.value) }, 'Open my link'),
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
      h('details', { class: 'guide' },
        h('summary', { class: 'small strong' }, 'Optional: ring the office boy’s phone when the app is closed'),
        h('p', { class: 'muted small' }, 'Uses a free Firebase project. You can add it any time later in Settings → Phone notifications, which shows every step:'),
        h('ol', { class: 'steps muted' },
          h('li', {}, 'Create a Firebase project and add a Web app. Copy its config.'),
          h('li', {}, 'Cloud Messaging → Web Push certificates → Generate key pair.'),
          h('li', {}, 'Service accounts → Generate new private key (a .json file).'),
          h('li', {}, 'Paste all three into Settings → Phone notifications.'),
        ),
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

/** Shown after someone opens their personal link in a phone browser: install the app first. */
export function renderInstall(root, { name, link, onContinue }) {
  const firstName = String(name || '').split(' ')[0];
  const body = h('div', { class: 'stack', style: 'gap:14px' });
  let copied = false;
  let installed = false;

  const copyButton = (primary) => h('button', {
    class: `btn ${primary ? 'primary' : ''} block`,
    onclick: async () => {
      copied = await copyText(link);
      toast(copied ? 'Link copied' : 'Couldn’t copy. Copy the link from your message instead.', copied ? '' : 'error');
      draw();
    },
  }, icon(copied ? 'check' : 'copy'), copied ? 'Link copied' : 'Copy my link');

  const step = (n, title, detail, extra) => h('li', { class: 'install-step' },
    h('span', { class: 'step-num' }, n),
    h('div', { class: 'grow stack', style: 'gap:6px' }, h('div', { class: 'strong' }, title), detail && h('div', { class: 'muted small' }, detail), extra),
  );

  function draw() {
    if (isInAppBrowser) {
      fill(
        h('section', { class: 'card' },
          h('div', { class: 'notice' }, 'This link opened inside another app (like WhatsApp). Apps can only be installed from ', isIOS ? 'Safari.' : 'Chrome.'),
          h('ol', { class: 'install-steps' },
            step(1, 'Copy your link', null, copyButton(true)),
            isIOS
              ? step(2, 'Open it in Safari', 'Tap ••• or the compass icon and choose “Open in Safari”. Or open Safari and paste the link.')
              : step(2, 'Open it in Chrome', 'Tap ⋮ at the top and choose “Open in Chrome”. Or open Chrome and paste the link.'),
            step(3, 'Install from there', 'You’ll see the install steps again.'),
          ),
        ),
      );
      return;
    }
    if (isIOS) {
      fill(
        h('section', { class: 'card' },
          h('ol', { class: 'install-steps' },
            step(1, 'Copy your link', 'You’ll paste it once when the app opens for the first time.', copyButton(!copied)),
            step(2, h('span', {}, 'Tap the Share button ', h('span', { class: 'inline-icon' }, icon('share'))), 'At the bottom of Safari (top right on iPad, or in the address bar in Chrome).'),
            step(3, h('span', {}, 'Tap “Add to Home Screen” ', h('span', { class: 'inline-icon' }, icon('addSquare'))), 'Scroll down the list if you don’t see it. Then tap Add.'),
            step(4, 'Open OfficeBoy from your home screen', 'Tap “Paste my link”. That’s it: you stay signed in.'),
          ),
        ),
      );
      return;
    }
    if (installed) {
      fill(h('section', { class: 'card soft center' },
        h('h2', {}, 'Installed ✓'),
        h('p', {}, 'Open OfficeBoy from your home screen. You’re already signed in.'),
      ));
      return;
    }
    if (canPromptInstall()) {
      fill(h('section', { class: 'card' },
        h('button', {
          class: 'btn primary big block',
          onclick: async () => {
            installed = await promptInstall();
            draw();
          },
        }, icon('phone'), 'Install app'),
        h('p', { class: 'muted small center' }, 'Free, about 1 MB. No Play Store needed.'),
      ));
      return;
    }
    fill(h('section', { class: 'card' },
      markInstalledHint() && h('div', { class: 'notice' }, 'Looks like it’s already installed. Open OfficeBoy from your home screen.'),
      h('ol', { class: 'install-steps' },
        step(1, h('span', {}, 'Tap the menu ', h('span', { class: 'inline-icon' }, icon('dots'))), 'Top right corner in Chrome.'),
        step(2, 'Tap “Install app” or “Add to Home screen”', isAndroid ? 'Then tap Install.' : 'Use Chrome, Edge or Samsung Internet.'),
        step(3, 'Open OfficeBoy from your home screen', 'You’re already signed in.'),
      ),
    ));
  }

  function fill(...children) {
    body.replaceChildren(...children.filter(Boolean));
  }

  root.append(page(
    hero(`Hi ${firstName}, install OfficeBoy`, 'Add it to your home screen. It opens like an app and stays signed in.'),
    body,
    h('button', { class: 'btn ghost', onclick: onContinue }, 'Continue in the browser for now'),
  ));
  draw();
  return onInstallChange(draw);
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
