import { api } from '../api.js';
import { mountCallCard } from './calls.js';
import { h, fill, icon, loading, toast, openSheet, errorText, timeLabel, dateLabel, untilLabel, drinkLabel, greeting, poll } from '../ui.js';

const AWAY = { wfh: 'working from home', leave: 'on leave' };

/** Employee home: am I in today, and do I want each round's drink before its cutoff. */
export async function renderToday(main, { onSession, onAuthError }) {
  let state = null;
  let offset = 0; // server clock minus device clock
  let busy = null; // key of the action in progress
  let failed = null;
  const callSlot = h('div', { class: 'stack' }); // kept across redraws; manages itself
  let stopCallCard = null;

  const now = () => Date.now() + offset;

  async function load() {
    try {
      const data = await api('me');
      apply(data);
      onSession(data);
      failed = null;
    } catch (err) {
      if (onAuthError(err)) return;
      failed = err;
      if (!state) draw();
    }
  }

  function apply(data) {
    // Older Apps Script versions don't send feature flags: treat everything as on.
    data.features = { showAttendance: true, allowAutoBook: true, allowRoundChange: true, showCountdown: true, callReasons: [], ...data.features };
    state = data;
    offset = data.serverNow - Date.now();
    // Managers the admin allowed to call get the "Call office boy" card.
    const canCall = data.user.canCall && data.features?.callReasons?.length > 0;
    if (canCall && !stopCallCard) stopCallCard = mountCallCard(callSlot, { features: data.features, onAuthError });
    if (!canCall && stopCallCard) {
      stopCallCard();
      stopCallCard = null;
    }
    draw();
  }

  async function act(key, action, payload, success) {
    if (busy) return;
    busy = key;
    draw();
    try {
      apply(await api(action, payload));
      if (success) toast(success);
    } catch (err) {
      if (!onAuthError(err)) {
        toast(errorText(err), 'error');
        if (err.code === 'locked') load();
      }
    } finally {
      busy = null;
      if (state) draw();
    }
  }

  function draw() {
    if (!state) {
      fill(main, failed
        ? h('div', { class: 'card' }, h('p', {}, errorText(failed)), h('button', { class: 'btn primary', onclick: () => { failed = null; draw(); load(); } }, 'Try again'))
        : loading());
      return;
    }
    const { user } = state;
    fill(main, 
      h('section', { class: 'hello stack', style: 'gap:4px' },
        h('h1', {}, `${greeting()}, ${user.name.split(' ')[0]}`),
        h('p', { class: 'muted' }, dateLabel(state.today)),
      ),
      stopCallCard && callSlot,
      state.features.showAttendance && attendanceCard(),
      !user.defaultDrink && h('section', { class: 'card soft' },
        h('h2', {}, 'Pick your usual drink'),
        h('p', { class: 'small' }, 'Choose it once. After that, booking a round is a single tap.'),
        h('button', { class: 'btn primary', onclick: () => pickDrink(null) }, 'Choose my usual'),
      ),
      state.rounds.length ? state.rounds.map(roundCard) : h('div', { class: 'card empty' }, 'No tea rounds are set up yet.'),
      usualCard(),
    );
  }

  function attendanceCard() {
    const options = [['office', 'In office'], ['wfh', 'WFH'], ['leave', 'Leave']];
    return h('section', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', {}, 'Where are you today?'),
        state.attendance === 'unknown' && h('span', { class: 'pill warn' }, 'Not set'),
      ),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Attendance' },
        options.map(([value, label]) => h('button', {
          'aria-pressed': String(state.attendance === value),
          disabled: !!busy,
          onclick: () => state.attendance !== value && act(`att-${value}`, 'setAttendance', { status: value }),
        }, busy === `att-${value}` ? h('span', { class: 'spinner', style: 'width:16px;height:16px;border-width:2px' }) : label)),
      ),
    );
  }

  function roundCard(round) {
    const { user } = state;
    const order = round.order;
    const locked = round.locked || now() >= round.cutoffAt;
    const away = AWAY[state.attendance];
    const booked = order && (order.status === 'booked' || order.status === 'delivered');
    const skipped = order && order.status === 'skipped';
    const choice = booked ? drinkLabel(order.drink, order.sugar) : drinkLabel(user.defaultDrink, user.defaultSugar);

    const head = h('div', { class: 'round-head' },
      h('div', {},
        h('h2', {}, `${round.name} ${round.name.toLowerCase().includes('tea') ? '' : 'round'}`.trim()),
        h('p', { class: 'muted small' }, `Served at ${timeLabel(round.serveTime)}`),
      ),
      locked
        ? h('span', { class: 'pill' }, icon('lock'), 'Closed')
        : booked ? h('span', { class: 'pill ok' }, 'Booked')
        : skipped ? h('span', { class: 'pill' }, 'Skipped')
        : h('span', { class: 'pill warn' }, 'Not booked'),
    );

    if (locked) {
      const result = order?.status === 'delivered'
        ? [h('span', { class: 'pill ok' }, icon('check'), 'Delivered'), drinkLabel(order.drink, order.sugar)]
        : booked ? [`You booked ${drinkLabel(order.drink, order.sugar)}`]
        : ['You didn’t book this round'];
      return h('section', { class: 'card' }, head,
        h('div', { class: 'result' }, result),
        h('p', { class: 'muted small' }, `Booking closed at ${timeLabel(round.cutoffTime)}.`),
      );
    }

    if (away) {
      return h('section', { class: 'card' }, head,
        h('p', { class: 'muted' }, `You’re marked ${away} today, so nothing is booked. Switch to “In office” to book.`),
      );
    }

    const remaining = round.cutoffAt - now();
    return h('section', { class: 'card' }, head,
      h('div', { class: 'drink-line' },
        h('div', { class: 'cup' }, icon('cup')),
        h('div', { class: 'grow' },
          h('div', { class: 'strong' }, choice || 'No drink chosen'),
          h('div', { class: 'muted tiny' }, booked && order.auto ? 'Auto-booked from your usual' : booked ? 'Your drink for this round' : 'Your usual'),
        ),
        state.features.allowRoundChange && h('button', { class: 'btn sm', disabled: !!busy, onclick: () => pickDrink(round) }, 'Change'),
      ),
      h('div', { class: 'choice-pair' },
        h('button', {
          class: 'btn big yes', 'aria-pressed': String(!!booked), disabled: !!busy,
          onclick: () => {
            if (booked) return;
            if (!choice) return pickDrink(round);
            act(`yes-${round.id}`, 'book', { roundId: round.id, want: true }, `${round.name}: ${choice} booked`);
          },
        }, busy === `yes-${round.id}` ? h('span', { class: 'spinner' }) : [icon('check'), 'Yes, I’ll have it']),
        h('button', {
          class: 'btn big no', 'aria-pressed': String(!!skipped), disabled: !!busy,
          onclick: () => !skipped && act(`no-${round.id}`, 'book', { roundId: round.id, want: false }, `${round.name}: skipped`),
        }, busy === `no-${round.id}` ? h('span', { class: 'spinner' }) : 'No, skip'),
      ),
      state.features.showCountdown && h('div', { class: `countdown${remaining < 15 * 60000 ? ' soon' : ''}` },
        icon('clock'),
        `Booking closes at ${timeLabel(round.cutoffTime)} · ${untilLabel(remaining)} left`,
      ),
    );
  }

  function usualCard() {
    const { user } = state;
    if (!user.defaultDrink) return null;
    const toggle = h('input', {
      type: 'checkbox', checked: user.autoBook, disabled: !!busy,
      onchange: () => act('auto', 'savePrefs', { autoBook: toggle.checked }, toggle.checked ? 'Auto-book is on' : 'Auto-book is off'),
    });
    return h('section', { class: 'card flat' },
      h('div', { class: 'row between' },
        h('div', {},
          h('div', { class: 'muted tiny strong' }, 'MY USUAL'),
          h('div', { class: 'strong' }, drinkLabel(user.defaultDrink, user.defaultSugar)),
        ),
        h('button', { class: 'btn sm', disabled: !!busy, onclick: () => pickDrink(null) }, 'Change'),
      ),
      state.features.allowAutoBook && h('label', { class: 'switch' }, toggle,
        h('span', {},
          h('span', { class: 'strong' }, 'Auto-book my usual'),
          h('span', { class: 'muted small', style: 'display:block' }, 'Count me in for every round unless I tap “No” or mark WFH/Leave.'),
        ),
      ),
    );
  }

  /** round = null edits the usual drink only. */
  async function pickDrink(round) {
    const { user, menu, sugarOptions, features } = state;
    const current = round?.order?.drink && round.order.status !== 'skipped' ? round.order : { drink: user.defaultDrink, sugar: user.defaultSugar };
    let drink = menu.find((m) => m.name === current.drink) || null;
    let sugar = sugarOptions.includes(current.sugar) ? current.sugar : sugarOptions[0] || '';
    // Without per-round changes, picking a drink always means setting the usual.
    const usualOnly = !features.allowRoundChange;
    let makeUsual = usualOnly || !user.defaultDrink || !round;
    const sugarFor = (d) => (d?.hasSugar && sugarOptions.length ? sugar : '');

    const result = await openSheet((close) => {
      const body = h('div', { class: 'stack' });
      const confirm = h('button', { class: 'btn primary big block' });
      const render = () => {
        confirm.disabled = !drink;
        confirm.textContent = !drink ? 'Pick a drink' : round ? `Book ${drinkLabel(drink.name, sugarFor(drink))}` : 'Save my usual';
        fill(body, 
          h('div', { class: 'section-title' }, 'Drink'),
          h('div', { class: 'chips' }, menu.map((m) => h('button', {
            class: 'chip', 'aria-pressed': String(drink?.name === m.name), onclick: () => { drink = m; render(); },
          }, m.name))),
          drink?.hasSugar && sugarOptions.length > 0 && [
            h('div', { class: 'section-title' }, 'Sugar'),
            h('div', { class: 'seg' }, sugarOptions.map((s) => h('button', {
              'aria-pressed': String(sugar === s), onclick: () => { sugar = s; render(); },
            }, s))),
          ],
          round && !usualOnly && h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: makeUsual, onchange: (e) => { makeUsual = e.target.checked; } }),
            'Also save as my usual drink'),
        );
      };
      confirm.addEventListener('click', () => close({ drink: drink.name, sugar: sugarFor(drink) }));
      render();
      return [
        h('div', { class: 'row between' },
          h('h2', {}, round ? `${round.name} · what would you like?` : 'Your usual drink'),
          h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        ),
        body,
        confirm,
      ];
    });
    if (!result) return;

    busy = round ? `yes-${round.id}` : 'usual';
    draw();
    try {
      if (makeUsual) apply(await api('savePrefs', { defaultDrink: result.drink, defaultSugar: result.sugar }));
      if (round) apply(await api('book', { roundId: round.id, want: true, drink: result.drink, sugar: result.sugar }));
      toast(round ? `${round.name}: ${drinkLabel(result.drink, result.sugar)} booked` : 'Usual drink saved');
    } catch (err) {
      if (!onAuthError(err)) toast(errorText(err), 'error');
    } finally {
      busy = null;
      draw();
    }
  }

  draw();
  await load();

  // Redraw every 20 s so countdowns tick and rounds lock on time; re-fetch every minute for changes.
  let ticks = 0;
  const stopPoll = poll(() => {
    ticks++;
    if (busy) return;
    if (ticks % 3 === 0) load();
    else if (state && !document.querySelector('.backdrop')) draw();
  }, 20000);
  return () => {
    stopPoll();
    stopCallCard?.();
  };
}
