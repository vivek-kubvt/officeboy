import { api, lastReply } from '../api.js';
import { h, fill, icon, loading, toast, errorText, timeLabel, dateLabel, untilLabel, poll } from '../ui.js';

/** Office boy's live view: what to prepare for each round and who to deliver to. */
export async function renderBoard(main, { onAuthError }) {
  let state = null;
  let selected = null;
  let offset = 0;
  let loadedAt = 0;
  let failed = null;
  let refreshing = false;
  const pending = new Set(); // userIds with a delivery toggle in flight

  const now = () => Date.now() + offset;

  async function load() {
    if (refreshing || pending.size) return;
    refreshing = true;
    draw();
    try {
      apply(await api('board'));
      failed = null;
    } catch (err) {
      if (onAuthError(err)) return;
      failed = err;
    } finally {
      refreshing = false;
      draw();
    }
  }

  function apply(data, saved) {
    state = data;
    offset = saved ? saved.offset : data.serverNow - Date.now();
    loadedAt = saved ? 0 : Date.now();
    if (!saved) lastReply.set('board', data);
    if (!selected || !data.rounds.some((r) => r.id === selected)) selected = data.currentRoundId;
  }

  function draw() {
    if (!state) {
      fill(main, failed
        ? h('div', { class: 'card' }, h('p', {}, errorText(failed)), h('button', { class: 'btn primary', onclick: load }, 'Try again'))
        : loading());
      return;
    }
    const round = state.rounds.find((r) => r.id === selected);
    const { headcount } = state;
    const ago = Math.round((Date.now() - loadedAt) / 1000);

    fill(main, 
      h('div', { class: 'row between' },
        h('div', {},
          h('h1', {}, 'Today'),
          h('p', { class: 'muted small' }, dateLabel(state.today)),
        ),
        h('button', { class: 'btn sm', onclick: load, disabled: refreshing, 'aria-label': 'Refresh' },
          refreshing ? h('span', { class: 'spinner' }) : icon('refresh'),
          !loadedAt ? 'Updating' : ago < 10 ? 'Updated now' : `${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago`),
      ),
      failed && h('div', { class: 'notice' }, `Couldn’t refresh: ${errorText(failed)}`),
      h('div', { class: 'stats' },
        stat(headcount.office, 'In office'),
        stat(headcount.wfh, 'WFH'),
        stat(headcount.leave, 'Leave'),
        stat(headcount.unknown, 'No reply'),
      ),
      state.rounds.length > 1 && h('div', { class: 'seg', role: 'tablist' },
        state.rounds.map((r) => h('button', {
          role: 'tab', 'aria-pressed': String(r.id === selected),
          onclick: () => { selected = r.id; draw(); },
        }, `${r.name} · ${timeLabel(r.serveTime)}`)),
      ),
      round ? roundView(round) : h('div', { class: 'card empty' }, 'No rounds are set up yet. The admin can add them in Settings.'),
      state.noReply.length > 0 && h('details', { class: 'card flat' },
        h('summary', { class: 'strong', style: 'cursor:pointer' }, `No reply yet (${state.noReply.length})`),
        h('p', { class: 'muted small' }, state.noReply.join(', ')),
      ),
    );
  }

  function stat(value, label) {
    return h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
  }

  function roundView(round) {
    const locked = round.locked || now() >= round.cutoffAt;
    const pct = round.total ? Math.round((round.delivered / round.total) * 100) : 0;
    return [
      h('section', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', {},
            h('h2', {}, round.name),
            h('p', { class: 'muted small' }, `Serve at ${timeLabel(round.serveTime)}`),
          ),
          locked
            ? h('span', { class: 'pill ok' }, icon('lock'), 'Final count')
            : h('span', { class: 'pill warn' }, `Open · closes in ${untilLabel(round.cutoffAt - now())}`),
        ),
        h('div', { class: 'row', style: 'align-items:flex-end;gap:14px' },
          h('div', { class: 'big-number' }, round.total),
          h('div', { class: 'muted', style: 'padding-bottom:4px' }, round.total === 1 ? 'cup to make' : 'cups to make',
            round.skipped ? ` · ${round.skipped} skipped` : ''),
        ),
        !locked && h('p', { class: 'small muted' }, `People can still change their order until ${timeLabel(round.cutoffTime)}.`),
        round.total > 0 && h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${pct}%` })),
          h('p', { class: 'tiny muted' }, `${round.delivered} of ${round.total} delivered`),
        ),
      ),
      round.total > 0 && h('div', { class: 'section-title' }, 'To prepare'),
      round.total > 0 && h('section', { class: 'card' },
        round.groups.map((g) => h('div', { class: 'group-row' },
          h('div', { class: 'grow' },
            h('div', { class: 'strong' }, g.drink),
            h('div', { class: 'muted small' }, g.sugar ? (g.sugar === 'No sugar' ? 'No sugar' : `${g.sugar} sugar`) : '—'),
          ),
          g.delivered > 0 && h('span', { class: 'pill ok' }, `${g.delivered} done`),
          h('div', { class: 'count' }, `×${g.count}`),
        )),
      ),
      round.total > 0 && h('div', { class: 'section-title' }, 'Deliver to'),
      round.total > 0 && h('section', { class: 'card' },
        round.people.map((p) => h('div', {
          class: `person-row${p.delivered ? ' done' : ''}`,
          role: 'checkbox', 'aria-checked': String(p.delivered), tabindex: 0,
          onclick: () => toggle(round, p),
          onkeydown: (e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggle(round, p)),
        },
          h('div', { class: 'tick' }, pending.has(p.userId) ? h('span', { class: 'spinner', style: 'width:14px;height:14px;border-width:2px' }) : icon('check')),
          h('div', { class: 'grow who' },
            h('div', { class: 'strong' }, p.name),
            h('div', { class: 'muted small' }, [p.desk, p.label].filter(Boolean).join(' · ')),
          ),
        )),
      ),
      round.total === 0 && h('div', { class: 'card empty' }, locked ? 'Nobody booked this round.' : 'No bookings yet. Orders appear here as people book.'),
    ];
  }

  async function toggle(round, person) {
    if (pending.has(person.userId)) return;
    pending.add(person.userId);
    const target = !person.delivered;
    person.delivered = target; // optimistic
    round.delivered += target ? 1 : -1;
    draw();
    try {
      const data = await api('deliver', { roundId: round.id, userId: person.userId, delivered: target });
      pending.delete(person.userId);
      if (!pending.size) apply(data);
    } catch (err) {
      pending.delete(person.userId);
      person.delivered = !target;
      round.delivered += target ? -1 : 1;
      if (!onAuthError(err)) toast(errorText(err), 'error');
    }
    draw();
  }

  const saved = lastReply.get('board');
  if (saved) apply(saved.data, saved);
  draw();
  await load();
  let ticks = 0;
  return poll(() => (++ticks % 2 === 0 ? load() : draw()), 10000); // redraw every 10 s, fetch every 20 s
}

/** Last 14 days of cups and headcount. */
export async function renderHistory(main, { onAuthError }) {
  fill(main, loading());
  let data;
  try {
    data = await api('history');
  } catch (err) {
    if (onAuthError(err)) return;
    fill(main, h('div', { class: 'card' }, h('p', {}, errorText(err)), h('button', { class: 'btn primary', onclick: () => renderHistory(main, { onAuthError }) }, 'Try again')));
    return;
  }
  fill(main, 
    h('div', {}, h('h1', {}, 'Last 14 days'), h('p', { class: 'muted small' }, 'Cups served and people in office each day.')),
    data.days.length
      ? h('section', { class: 'card' }, data.days.map((d) => h('div', { class: 'day-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'strong' }, d.date === data.today ? 'Today' : dateLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })),
          h('div', { class: 'muted small' }, Object.entries(d.items).sort((a, b) => b[1] - a[1]).map(([label, n]) => `${label} ×${n}`).join(', ') || 'No drinks'),
        ),
        h('div', { class: 'center' }, h('div', { class: 'strong' }, d.cups), h('div', { class: 'tiny muted' }, 'cups')),
        h('div', { class: 'center' }, h('div', { class: 'strong' }, d.office), h('div', { class: 'tiny muted' }, 'in office')),
      )))
      : h('div', { class: 'card empty' }, 'Nothing recorded in the last 14 days.'),
  );
}
