import { api, session, inviteLink } from '../api.js';
import { h, fill, icon, loading, toast, openSheet, confirmSheet, withBusy, errorText, initials, localDate, dateLabel } from '../ui.js';

const ROLE_NAMES = { employee: 'Employee', officeboy: 'Office boy', admin: 'Admin' };

function failure(main, err, retry) {
  fill(main, h('div', { class: 'card' }, h('p', {}, errorText(err)), h('button', { class: 'btn primary', onclick: retry }, 'Try again')));
}

// ------------------------------------------------------------------ people

export async function renderPeople(main, ctx) {
  let data = null;
  let filter = 'all';

  async function load() {
    fill(main, loading());
    try {
      data = await api('adminData');
      draw();
    } catch (err) {
      if (!ctx.onAuthError(err)) failure(main, err, load);
    }
  }

  function draw() {
    const counts = { all: data.users.length, employee: 0, officeboy: 0, admin: 0 };
    data.users.forEach((u) => counts[u.role]++);
    const people = data.users
      .filter((u) => filter === 'all' || u.role === filter)
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

    fill(main, 
      h('div', { class: 'row between wrap' },
        h('div', {}, h('h1', {}, 'People'), h('p', { class: 'muted small' }, 'Everyone signs in with a personal link. No passwords.')),
        h('button', { class: 'btn primary', onclick: () => edit(null) }, icon('plus'), 'Add person'),
      ),
      data.users.length <= 1 && h('div', { class: 'card soft' },
        h('h2', {}, 'Add your team'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Add each employee and your office boy.'),
          h('li', {}, 'Tap “Share link” and send it on WhatsApp, Slack or email.'),
          h('li', {}, 'They open it once and add it to their home screen. It stays signed in.'),
        ),
      ),
      h('div', { class: 'chips scroll' },
        [['all', 'All'], ['employee', 'Employees'], ['officeboy', 'Office boys'], ['admin', 'Admins']].map(([value, label]) =>
          h('button', { class: 'chip', 'aria-pressed': String(filter === value), onclick: () => { filter = value; draw(); } }, `${label} · ${counts[value]}`)),
      ),
      h('section', { class: 'card' },
        people.length
          ? people.map((u) => h('div', { class: 'person-card' },
            h('div', { class: `avatar${u.active ? '' : ' off'}` }, initials(u.name)),
            h('div', { class: 'grow' },
              h('div', { class: 'row', style: 'gap:6px' },
                h('span', { class: 'strong' }, u.name),
                u.id === data.meId && h('span', { class: 'pill' }, 'You'),
                u.canCall && h('span', { class: 'pill brand', title: 'Can call office boy' }, icon('bell'), 'Can call'),
              ),
              h('div', { class: 'muted small' },
                [u.title || ROLE_NAMES[u.role], u.desk, u.active ? '' : 'Deactivated'].filter(Boolean).join(' · ')),
            ),
            h('div', { class: 'actions' },
              u.active && h('button', { class: 'btn sm primary', onclick: () => share(u) }, icon('share'), 'Share link'),
              h('button', { class: 'btn sm', onclick: () => edit(u) }, 'Edit'),
            ),
          ))
          : h('div', { class: 'empty' }, 'Nobody here yet.'),
      ),
      h('p', { class: 'muted tiny center' }, 'Anyone with a person’s link can order as them. If a link leaks or someone leaves, use Edit → Reset link.'),
    );
  }

  async function share(user) {
    const link = inviteLink(session.get().backend, user.token);
    const office = data.officeName;
    const text = user.role === 'officeboy'
      ? `Hi ${user.name}, this is your OfficeBoy link for ${office}. Open it to see today’s tea and coffee orders. Add it to your home screen.`
      : `Hi ${user.name}, this is your OfficeBoy link for ${office}. Open it to book your tea or coffee each day. Add it to your home screen.`;

    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: `OfficeBoy · ${office}`, text, url: link });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    openSheet((close) => {
      const input = h('input', { class: 'input', readonly: true, value: link, onfocus: (e) => e.target.select() });
      return [
        h('div', { class: 'row between' }, h('h2', {}, `Link for ${user.name}`), h('button', { class: 'btn ghost', onclick: () => close() }, 'Done')),
        h('p', { class: 'muted small' }, 'Send this link only to this person. It signs them in without a password.'),
        input,
        h('div', { class: 'sheet-actions' },
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(`${text}\n${link}`);
                toast('Message and link copied');
              } catch {
                input.select();
                toast('Press Copy on your keyboard');
              }
            },
          }, 'Copy'),
          h('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(`${text}\n${link}`)}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'),
          h('a', { class: 'btn', href: `mailto:?subject=${encodeURIComponent(`Your OfficeBoy link`)}&body=${encodeURIComponent(`${text}\n\n${link}`)}` }, 'Email'),
        ),
      ];
    });
  }

  async function edit(user) {
    const isNew = !user;
    const isMe = user?.id === data.meId;
    const name = h('input', { class: 'input', value: user?.name || '', maxlength: 60, placeholder: 'Full name', required: true });
    const desk = h('input', { class: 'input', value: user?.desk || '', maxlength: 40, placeholder: 'e.g. 2nd floor, desk 14 or Cabin 1' });
    const title = h('input', { class: 'input', value: user?.title || '', maxlength: 40, placeholder: 'e.g. CEO, HR Manager (optional)' });
    const canCall = h('input', { type: 'checkbox', checked: !!user?.canCall });
    const role = h('select', { class: 'input', disabled: isMe },
      Object.entries(ROLE_NAMES).map(([value, label]) => h('option', { value, selected: (user?.role || 'employee') === value }, label)));
    const active = h('input', { type: 'checkbox', checked: user ? user.active : true, disabled: isMe });
    const error = h('div', { class: 'notice error', hidden: true });

    await openSheet((close) => {
      const save = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Add person' : 'Save');
      return h('form', {
        class: 'stack',
        style: 'gap:14px',
        onsubmit: (e) => {
          e.preventDefault();
          error.hidden = true;
          withBusy(save, async () => {
            try {
              data = await api('saveUser', { user: { id: user?.id, name: name.value, desk: desk.value, title: title.value, canCall: canCall.checked, role: role.value, active: active.checked } });
              close();
              draw();
              toast(isNew ? `${name.value.trim()} added. Now share their link.` : 'Saved');
            } catch (err) {
              if (ctx.onAuthError(err)) return close();
              error.textContent = errorText(err);
              error.hidden = false;
            }
          });
        },
      },
        h('div', { class: 'row between' }, h('h2', {}, isNew ? 'Add person' : `Edit ${user.name}`), h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Cancel')),
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Role'), role),
        h('label', { class: 'field' }, h('span', {}, 'Job title'), title),
        h('label', { class: 'field' }, h('span', {}, 'Desk, cabin or floor (helps the office boy deliver)'), desk),
        h('label', { class: 'switch' }, canCall, h('span', {},
          h('span', { class: 'strong' }, 'Can call office boy'),
          h('span', { class: 'muted small', style: 'display:block' }, 'Shows a “Call office boy” button. His phone rings with their name, title and cabin.'))),
        !isNew && h('label', { class: 'switch' }, active, h('span', {}, h('span', { class: 'strong' }, 'Active'), h('span', { class: 'muted small', style: 'display:block' }, 'Deactivated people can’t open the app and aren’t counted.'))),
        error,
        save,
        !isNew && h('div', { class: 'divider' }),
        !isNew && h('button', {
          class: 'btn danger', type: 'button',
          onclick: async (e) => {
            const ok = await confirmSheet({
              title: 'Reset link?',
              message: `${user.name}’s current link will stop working right away. You’ll need to share the new link with them.`,
              confirm: 'Reset link', danger: true,
            });
            if (!ok) return;
            withBusy(e.target, async () => {
              try {
                data = await api('resetLink', { userId: user.id });
                if (data.ownToken) session.update({ token: data.ownToken });
                close();
                draw();
                toast('Link reset. Share the new one.');
                const fresh = data.users.find((u) => u.id === user.id);
                if (fresh?.active) share(fresh);
              } catch (err) {
                if (ctx.onAuthError(err)) return close();
                error.textContent = errorText(err);
                error.hidden = false;
              }
            });
          },
        }, 'Reset link'),
      );
    });
  }

  await load();
}

// ------------------------------------------------------------------ settings

export async function renderSettings(main, ctx) {
  let data = null;
  let draft = null;

  async function load() {
    fill(main, loading());
    try {
      data = await api('adminData');
      draft = {
        officeName: data.officeName,
        rounds: data.rounds.map((r) => ({ ...r })),
        menu: data.menu.map((m) => ({ ...m })),
        features: { ...data.features, sugarOptions: [...(data.features?.sugarOptions || [])], callReasons: [...(data.features?.callReasons || [])] },
      };
      draw();
    } catch (err) {
      if (!ctx.onAuthError(err)) failure(main, err, load);
    }
  }

  function draw() {
    const error = h('div', { class: 'notice error', hidden: true });
    const save = h('button', {
      class: 'btn primary big block',
      onclick: () => withBusy(save, async () => {
        error.hidden = true;
        try {
          data = await api('saveSettings', draft);
          session.update({ officeName: data.officeName });
          toast('Settings saved');
          await load();
        } catch (err) {
          if (ctx.onAuthError(err)) return;
          error.textContent = errorText(err);
          error.hidden = false;
        }
      }),
    }, 'Save settings');

    fill(main, 
      h('div', {}, h('h1', {}, 'Settings'), h('p', { class: 'muted small' }, 'Changes apply to everyone after you save.')),

      h('section', { class: 'card' },
        h('h2', {}, 'Office'),
        h('label', { class: 'field' }, h('span', {}, 'Office name'),
          h('input', { class: 'input', value: draft.officeName, maxlength: 60, oninput: (e) => { draft.officeName = e.target.value; } })),
      ),

      h('section', { class: 'card' },
        h('div', {},
          h('h2', {}, 'Tea rounds'),
          h('p', { class: 'muted small' }, 'After the booking cutoff nobody can change their order, and the office boy sees the final count.'),
        ),
        h('div', {},
          draft.rounds.map((r, i) => h('div', { class: 'edit-row round' },
            h('input', { class: 'input sm', value: r.name, placeholder: 'Round name', 'aria-label': 'Round name', oninput: (e) => { r.name = e.target.value; } }),
            h('label', { class: 'field' }, h('span', { class: 'tiny' }, 'Booking closes'),
              h('input', { class: 'input sm', type: 'time', value: r.cutoffTime, oninput: (e) => { r.cutoffTime = e.target.value; } })),
            h('label', { class: 'field' }, h('span', { class: 'tiny' }, 'Served at'),
              h('input', { class: 'input sm', type: 'time', value: r.serveTime, oninput: (e) => { r.serveTime = e.target.value; } })),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.active, onchange: (e) => { r.active = e.target.checked; } }), 'On'),
            h('button', { class: 'btn sm ghost danger', 'aria-label': `Remove ${r.name}`, onclick: () => { draft.rounds.splice(i, 1); draw(); } }, 'Remove'),
          )),
        ),
        h('button', { class: 'btn sm', onclick: () => { draft.rounds.push({ name: '', serveTime: '', cutoffTime: '', active: true }); draw(); } }, icon('plus'), 'Add round'),
      ),

      h('section', { class: 'card' },
        h('div', {},
          h('h2', {}, 'Menu'),
          h('p', { class: 'muted small' }, 'Turn on “Sugar” for drinks where people choose normal, less or no sugar.'),
        ),
        h('div', {},
          draft.menu.map((m, i) => h('div', { class: 'edit-row' },
            h('input', { class: 'input sm', value: m.name, placeholder: 'Drink name', 'aria-label': 'Drink name', oninput: (e) => { m.name = e.target.value; } }),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.hasSugar, onchange: (e) => { m.hasSugar = e.target.checked; } }), 'Sugar'),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.active, onchange: (e) => { m.active = e.target.checked; } }), 'On'),
            h('button', { class: 'btn sm ghost danger', 'aria-label': `Remove ${m.name}`, onclick: () => { draft.menu.splice(i, 1); draw(); } }, 'Remove'),
          )),
        ),
        h('button', { class: 'btn sm', onclick: () => { draft.menu.push({ name: '', hasSugar: true, active: true }); draw(); } }, icon('plus'), 'Add drink'),
      ),

      featuresCard(),

      error,
      save,

      firebaseCard(),

      h('div', { class: 'section-title' }, 'Account'),
      passwordCard(),
      h('section', { class: 'card flat' },
        h('h2', {}, 'Your data'),
        h('p', { class: 'muted small' }, 'Everything is stored in your Google Sheet. Don’t share the sheet: it contains everyone’s sign-in links.'),
        h('a', { class: 'btn', href: data.sheetUrl, target: '_blank', rel: 'noopener' }, 'Open Google Sheet'),
      ),
      h('section', { class: 'card flat' },
        h('h2', {}, 'This device'),
        h('p', { class: 'muted small' }, 'Sign out here. You can log back in with the web app URL and admin password.'),
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (await confirmSheet({ title: 'Sign out?', message: 'You’ll need the web app URL and admin password to sign back in on this device.', confirm: 'Sign out', danger: true })) {
              session.clear();
              location.hash = '#/';
            }
          },
        }, 'Sign out'),
      ),
    );
  }

  function featuresCard() {
    const f = draft.features;
    const toggle = (key, title, hint) => h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: f[key], onchange: (e) => { f[key] = e.target.checked; } }),
      h('span', {}, h('span', { class: 'strong' }, title), h('span', { class: 'muted small', style: 'display:block' }, hint)),
    );
    return h('section', { class: 'card' },
      h('div', {},
        h('h2', {}, 'What people see'),
        h('p', { class: 'muted small' }, 'Turn options on or off. Hidden options are also blocked in the backend.'),
      ),
      h('div', { class: 'section-title' }, 'Employee screen'),
      h('div', { class: 'stack', style: 'gap:6px' },
        h('span', { class: 'strong' }, 'Sugar choices'),
        h('div', { class: 'chips' }, data.sugarOptions.map((option) => h('button', {
          class: 'chip', 'aria-pressed': String(f.sugarOptions.includes(option)),
          onclick: (e) => {
            f.sugarOptions = f.sugarOptions.includes(option)
              ? f.sugarOptions.filter((x) => x !== option)
              : data.sugarOptions.filter((x) => x === option || f.sugarOptions.includes(x));
            e.currentTarget.setAttribute('aria-pressed', String(f.sugarOptions.includes(option)));
          },
        }, option))),
        h('span', { class: 'muted small' }, 'Turn all off to hide sugar completely.'),
      ),
      toggle('showAttendance', 'Ask “Where are you today?”', 'In office / WFH / Leave buttons.'),
      toggle('allowRoundChange', 'Let people change drink per round', 'When off, every booking is their usual drink.'),
      toggle('allowAutoBook', 'Allow auto-book', 'People can be counted in automatically with their usual drink.'),
      toggle('showCountdown', 'Show booking countdown', '“Booking closes at 10:30 · 20 min left”.'),
      h('div', { class: 'section-title' }, 'Calling the office boy'),
      h('div', { class: 'stack', style: 'gap:6px' },
        h('span', { class: 'strong' }, 'Call reasons'),
        h('div', { class: 'chips' }, (data.callReasons || []).map((option) => h('button', {
          class: 'chip', 'aria-pressed': String(f.callReasons.includes(option)),
          onclick: (e) => {
            f.callReasons = f.callReasons.includes(option)
              ? f.callReasons.filter((x) => x !== option)
              : (data.callReasons || []).filter((x) => x === option || f.callReasons.includes(x));
            e.currentTarget.setAttribute('aria-pressed', String(f.callReasons.includes(option)));
          },
        }, option))),
        h('span', { class: 'muted small' }, 'Choose who can call in People → Edit → “Can call office boy”. Turn all reasons off to hide calling.'),
      ),
      toggle('allowCallNote', 'Allow a note with a call', 'e.g. “2 guests” or “bring biscuits”.'),
      h('div', { class: 'section-title' }, 'Office boy screen'),
      toggle('showNoReply', 'Show “No reply yet” list', 'Names of people who haven’t answered today.'),
      toggle('officeBoyHistory', 'Show History tab', 'Cups and headcount for the last 14 days.'),
    );
  }

  function firebaseCard() {
    const fb = data.firebase;
    const ready = fb?.ready;
    const configInput = h('textarea', { class: 'input mono', rows: 6, placeholder: 'const firebaseConfig = {\n  apiKey: "…",\n  projectId: "…",\n  messagingSenderId: "…",\n  appId: "…"\n};' });
    if (fb?.config) configInput.value = JSON.stringify(fb.config, null, 2);
    const vapidInput = h('input', { class: 'input mono', placeholder: 'BPx… (Web Push certificate key pair)', value: fb?.vapidKey || '' });
    let serviceAccount = '';
    const fileLabel = h('span', { class: 'muted small' }, ready ? `Saved: ${data.pushServiceAccount}. Choose a file only to replace it.` : 'No file chosen');
    const fileInput = h('input', {
      type: 'file', accept: '.json,application/json', class: 'file-input',
      onchange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        serviceAccount = await file.text();
        fileLabel.textContent = file.name;
      },
    });
    const error = h('div', { class: 'notice error', hidden: true });
    const save = h('button', {
      class: 'btn primary',
      onclick: () => withBusy(save, async () => {
        error.hidden = true;
        try {
          data = await api('saveFirebase', { config: parseFirebaseConfig(configInput.value), vapidKey: vapidInput.value.trim(), serviceAccount });
          toast('Phone notifications connected');
          draw();
        } catch (err) {
          if (ctx.onAuthError(err)) return;
          error.textContent = errorText(err);
          error.hidden = false;
        }
      }),
    }, ready ? 'Update' : 'Connect Firebase');

    return h('section', { class: 'card' },
      h('div', { class: 'row between wrap' },
        h('div', {},
          h('h2', {}, 'Phone notifications (Firebase)'),
          h('p', { class: 'muted small' }, 'Optional. Lets calls ring the office boy’s phone even when the app is closed. Free with a Firebase project.'),
        ),
        h('span', { class: `pill ${ready ? 'ok' : ''}` }, ready ? 'Connected ✓' : 'Not set up'),
      ),
      h('details', { class: 'guide', open: !ready },
        h('summary', { class: 'strong' }, 'How to set it up (about 5 minutes)'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Open ', h('a', { href: 'https://console.firebase.google.com/', target: '_blank', rel: 'noopener' }, 'console.firebase.google.com'), ' → Add project (Google Analytics not needed).'),
          h('li', {}, 'Project settings (⚙) → General → Your apps → Web (</>) → register any name → copy the ', h('code', {}, 'firebaseConfig'), ' block into box 1.'),
          h('li', {}, 'Project settings → Cloud Messaging → Web Push certificates → Generate key pair → copy the key into box 2.'),
          h('li', {}, 'Project settings → Service accounts → Generate new private key → choose that downloaded file in box 3. It is stored only in your Apps Script, never in the sheet.'),
          h('li', {}, 'In Apps Script, run ', h('code', {}, 'install'), ' once more and allow the new “connect to an external service” permission, then Deploy → Manage deployments → New version.'),
        ),
      ),
      h('label', { class: 'field' }, h('span', {}, '1. Firebase config'), configInput),
      h('label', { class: 'field' }, h('span', {}, '2. Web Push certificate key'), vapidInput),
      h('div', { class: 'field' }, h('span', {}, '3. Service account key (.json file)'),
        h('label', { class: 'btn sm file-btn' }, fileInput, 'Choose file'), fileLabel),
      error,
      h('div', { class: 'row wrap' },
        save,
        ready && h('button', {
          class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => {
            try {
              const r = await api('testPush', { target: 'officeboys' });
              toast(r.sent ? `Test sent to ${r.sent} phone${r.sent === 1 ? '' : 's'}` : r.reason === 'no-devices' ? 'No office boy phone has turned on notifications yet (Calls tab → Turn on notifications).' : 'Test failed. Check the Apps Script execution log.', r.sent ? '' : 'error');
            } catch (err) { toast(errorText(err), 'error'); }
          }),
        }, 'Send test to office boy'),
        ready && h('button', {
          class: 'btn ghost danger', onclick: async () => {
            if (!(await confirmSheet({ title: 'Disconnect Firebase?', message: 'Calls will only ring while the office boy’s app is open.', confirm: 'Disconnect', danger: true }))) return;
            try {
              data = await api('saveFirebase', { remove: true });
              draw();
            } catch (err) { toast(errorText(err), 'error'); }
          },
        }, 'Disconnect'),
      ),
    );
  }

  function passwordCard() {
    const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 6, required: true });
    const error = h('div', { class: 'notice error', hidden: true });
    const submit = h('button', { class: 'btn', type: 'submit' }, 'Change password');
    return h('form', {
      class: 'card flat',
      onsubmit: (e) => {
        e.preventDefault();
        error.hidden = true;
        withBusy(submit, async () => {
          try {
            await api('changePassword', { current: current.value, next: next.value });
            current.value = next.value = '';
            toast('Password changed');
          } catch (err) {
            if (ctx.onAuthError(err)) return;
            error.textContent = errorText(err);
            error.hidden = false;
          }
        });
      },
    },
      h('h2', {}, 'Admin password'),
      h('label', { class: 'field' }, h('span', {}, 'Current password'), current),
      h('label', { class: 'field' }, h('span', {}, 'New password (6+ characters)'), next),
      error,
      submit,
    );
  }

  await load();
}

/** Accepts the JS snippet from the Firebase console or plain JSON. */
function parseFirebaseConfig(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const config = {};
  for (const [, key, value] of String(text).matchAll(/(\w+)\s*:\s*["'`]([^"'`]+)["'`]/g)) config[key] = value;
  return config;
}

// ------------------------------------------------------------------ reports

export async function renderReports(main, ctx) {
  const today = new Date();
  let from = localDate(new Date(today.getFullYear(), today.getMonth(), 1));
  let to = localDate(today);
  let data = null;
  const body = h('div', { class: 'stack', style: 'gap:14px' });

  async function load(button) {
    const run = async () => {
      try {
        data = await api('report', { from, to });
        draw();
      } catch (err) {
        if (!ctx.onAuthError(err)) fill(body, h('div', { class: 'notice error' }, errorText(err)));
      }
    };
    if (button) return withBusy(button, run);
    fill(body, loading());
    return run();
  }

  const fromInput = h('input', { class: 'input sm', type: 'date', value: from, onchange: (e) => { from = e.target.value; } });
  const toInput = h('input', { class: 'input sm', type: 'date', value: to, onchange: (e) => { to = e.target.value; } });
  const loadBtn = h('button', { class: 'btn primary sm', onclick: () => load(loadBtn) }, 'Show');

  fill(main, 
    h('div', {}, h('h1', {}, 'Reports'), h('p', { class: 'muted small' }, 'Cups served and attendance. Today’s numbers become final after the last cutoff.')),
    h('section', { class: 'card flat' },
      h('div', { class: 'date-range' },
        h('label', { class: 'field' }, h('span', {}, 'From'), fromInput),
        h('label', { class: 'field' }, h('span', {}, 'To'), toInput),
        loadBtn,
      ),
    ),
    body,
  );

  function draw() {
    const officeDays = data.days.filter((d) => d.office > 0);
    const avgOffice = officeDays.length ? Math.round(officeDays.reduce((s, d) => s + d.office, 0) / officeDays.length) : 0;
    const max = Math.max(1, ...data.items.map((i) => i.count));

    fill(body, 
      h('div', { class: 'stats' },
        stat(data.totalCups, 'Cups'),
        stat(data.days.length, 'Days'),
        stat(avgOffice, 'Avg in office'),
        stat(data.days.length ? Math.round(data.totalCups / data.days.length) : 0, 'Cups / day'),
      ),
      data.totalCups === 0
        ? h('div', { class: 'card empty' }, 'No drinks recorded in this range.')
        : [
          h('section', { class: 'card' },
            h('div', { class: 'row between' },
              h('h2', {}, 'By drink'),
              h('button', { class: 'btn sm', onclick: downloadCsv }, 'Download CSV'),
            ),
            data.items.map((i) => h('div', { class: 'bar-row' },
              h('span', {}, i.label),
              h('div', { class: 'bar' }, h('div', { style: `width:${(i.count / max) * 100}%` })),
              h('span', { class: 'strong', style: 'text-align:right' }, i.count),
            )),
          ),
          h('section', { class: 'card' },
            h('h2', {}, 'By day'),
            h('div', { class: 'table-wrap' },
              h('table', {},
                h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'num' }, 'In office'), h('th', { class: 'num' }, 'Cups'), h('th', {}, 'Drinks'))),
                h('tbody', {}, data.days.map((d) => h('tr', {},
                  h('td', {}, dateLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })),
                  h('td', { class: 'num' }, d.office),
                  h('td', { class: 'num' }, d.cups),
                  h('td', { class: 'muted' }, Object.entries(d.items).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')),
                ))),
              ),
            ),
          ),
          h('section', { class: 'card' },
            h('h2', {}, 'By person'),
            h('div', { class: 'table-wrap' },
              h('table', {},
                h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'num' }, 'Cups'))),
                h('tbody', {}, data.people.map((p) => h('tr', {}, h('td', {}, p.label), h('td', { class: 'num' }, p.count)))),
              ),
            ),
          ),
        ],
    );
  }

  function stat(value, label) {
    return h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
  }

  function downloadCsv() {
    const labels = data.items.map((i) => i.label);
    const rows = [['Date', 'In office', 'Cups', ...labels]];
    [...data.days].reverse().forEach((d) => rows.push([d.date, d.office, d.cups, ...labels.map((l) => d.items[l] || 0)]));
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `officeboy-${data.from}-to-${data.to}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  await load();
}
