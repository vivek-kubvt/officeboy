/**
 * OfficeBoy backend — a Google Sheet acting as the database, served as an Apps Script web app.
 *
 * Setup (full guide in README.md):
 *   1. Create a blank Google Sheet → Extensions → Apps Script → replace Code.gs with this file.
 *   2. Select the `install` function and press Run once (grants access, creates the tabs and a trigger).
 *   3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   4. Paste the web app URL into the OfficeBoy app's setup screen.
 *
 * All times use the spreadsheet time zone (File → Settings). Do not re-order rows in the
 * Orders or Attendance tabs: the script reads them newest-first and stops at older dates.
 */

const SUGAR_OPTIONS = ['Normal', 'Less', 'No sugar'];
const ROLES = ['admin', 'employee', 'officeboy'];
const ATTENDANCE = ['office', 'wfh', 'leave'];

/** Options the admin can show or hide. Stored as JSON in Settings → features. */
const FEATURE_DEFAULTS = {
  sugarOptions: SUGAR_OPTIONS, // which sugar choices employees see; empty hides sugar completely
  showAttendance: true, // "Where are you today?" In office / WFH / Leave
  allowAutoBook: true, // employees can turn on auto-book for their usual drink
  allowRoundChange: true, // employees can pick a different drink for one round (off = always their usual)
  showCountdown: true, // "Booking closes in 20 min" on the employee screen
  showNoReply: true, // office boy sees who hasn't replied
  officeBoyHistory: true, // office boy has the History tab
};

const TABLES = {
  Settings: ['key', 'value'],
  Users: ['id', 'name', 'role', 'desk', 'token', 'defaultDrink', 'defaultSugar', 'autoBook', 'active', 'createdAt'],
  Menu: ['name', 'hasSugar', 'active'],
  Rounds: ['id', 'name', 'serveTime', 'cutoffTime', 'active'],
  Attendance: ['date', 'userId', 'status', 'updatedAt'],
  Orders: ['date', 'roundId', 'userId', 'drink', 'sugar', 'status', 'updatedAt'],
};

const SEEDS = {
  Menu: [
    ['Tea', true, true],
    ['Coffee', true, true],
    ['Milk', true, true],
    ['Green tea', false, true],
    ['Black coffee', true, true],
  ],
  Rounds: [
    ['morning', 'Morning', '11:00', '10:30', true],
    ['evening', 'Evening', '16:00', '15:30', true],
  ],
};

const ACTIONS = {
  status: status,
  setup: withLock(setup),
  adminLogin: adminLogin,
  me: auth(['admin', 'employee', 'officeboy'], me),
  book: auth(['admin', 'employee'], withLock(book)),
  setAttendance: auth(['admin', 'employee'], withLock(setAttendance)),
  savePrefs: auth(['admin', 'employee'], withLock(savePrefs)),
  board: auth(['admin', 'officeboy'], board),
  deliver: auth(['admin', 'officeboy'], withLock(deliver)),
  history: auth(['admin', 'officeboy'], history),
  adminData: auth(['admin'], adminData),
  saveUser: auth(['admin'], withLock(saveUser)),
  resetLink: auth(['admin'], withLock(resetLink)),
  saveSettings: auth(['admin'], withLock(saveSettings)),
  changePassword: auth(['admin'], withLock(changePassword)),
  report: auth(['admin'], report),
};

// ---------------------------------------------------------------- entry points

function doGet() {
  return json({ ok: true, data: { app: 'OfficeBoy', configured: isConfigured() } });
}

function doPost(e) {
  let body;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handler = ACTIONS[req.action];
    if (!handler) fail('Unknown action.');
    body = { ok: true, data: handler(req) };
  } catch (err) {
    if (!err.expected) console.error(err && err.stack ? err.stack : err);
    body = { ok: false, error: err.expected ? err.message : 'Server error: ' + (err && err.message), code: err.code || null };
  }
  return json(body);
}

/** Run once from the Apps Script editor. Safe to run again. */
function install() {
  Object.keys(TABLES).forEach(function (name) { sheet(name); });
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'finalizeTick'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('finalizeTick').timeBased().everyMinutes(10).create();
  console.log('Installed. Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).');
}

/** Time trigger: writes auto-booked orders into the sheet once a round's cutoff passes. */
function finalizeTick() {
  if (isConfigured()) finalizeDueRounds(context());
}

// ---------------------------------------------------------------- auth & setup

function status() {
  return { configured: isConfigured(), officeName: isConfigured() ? getSetting('officeName') : '' };
}

function setup(req) {
  if (isConfigured()) fail('This office is already set up. Log in with the admin password instead.');
  const officeName = clean(req.officeName, 60);
  const adminName = clean(req.adminName, 60);
  const password = String(req.password || '');
  if (!officeName || !adminName) fail('Office name and your name are required.');
  if (password.length < 6) fail('Password must be at least 6 characters.');

  Object.keys(TABLES).forEach(function (name) { sheet(name); });
  setSetting('officeName', officeName);
  const admin = newUser({ name: adminName, role: 'admin', desk: '' });
  appendRows('Users', [cells('Users', admin)]);
  setPassword(password);
  PropertiesService.getScriptProperties().setProperty('ownerId', admin.id);
  return { token: admin.token };
}

function adminLogin(req) {
  if (!isConfigured()) fail('This office is not set up yet.');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('loginFails') || 0);
  if (fails >= 10) fail('Too many wrong attempts. Try again in 15 minutes.');
  if (!checkPassword(req.password)) {
    cache.put('loginFails', String(fails + 1), 900);
    fail('Wrong password.');
  }
  cache.remove('loginFails');
  const ownerId = PropertiesService.getScriptProperties().getProperty('ownerId');
  const admins = loadUsers().filter(function (u) { return u.active && u.role === 'admin'; });
  const owner = admins.filter(function (u) { return u.id === ownerId; })[0] || admins[0];
  if (!owner) fail('No active admin found. Fix the Users tab in the sheet.');
  return { token: owner.token };
}

function changePassword(req) {
  if (!checkPassword(req.current)) fail('Current password is wrong.');
  if (String(req.next || '').length < 6) fail('New password must be at least 6 characters.');
  setPassword(String(req.next));
  return { changed: true };
}

function auth(roles, fn) {
  return function (req) {
    const token = String(req.token || '');
    const user = token.length >= 32 ? loadUsers().filter(function (u) { return u.active && u.token === token; })[0] : null;
    if (!user) fail('This link is not valid any more. Ask your admin for a new link.', 'auth');
    if (roles.indexOf(user.role) < 0) fail('Your role can’t do this.', 'role');
    return fn(req, user);
  };
}

function withLock(fn) {
  return function (req, user) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) fail('The sheet is busy. Try again in a moment.');
    try {
      return fn(req, user);
    } finally {
      lock.releaseLock();
    }
  };
}

function isConfigured() {
  return !!PropertiesService.getScriptProperties().getProperty('passwordHash');
}

function setPassword(password) {
  const salt = newToken();
  PropertiesService.getScriptProperties().setProperties({ passwordSalt: salt, passwordHash: hashPassword(password, salt) });
}

function checkPassword(password) {
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('passwordSalt');
  return !!salt && hashPassword(String(password || ''), salt) === props.getProperty('passwordHash');
}

function hashPassword(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < 200; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8)
      .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); })
      .join('');
  }
  return h;
}

// ---------------------------------------------------------------- employee

function me(req, user) {
  const ctx = context();
  finalizeDueRounds(ctx);
  return myDay(user, ctx);
}

function myDay(user, ctx) {
  const day = loadDay(ctx);
  const u = day.users.filter(function (x) { return x.id === user.id; })[0] || user;
  const booker = canBook(u);
  return {
    user: { id: u.id, name: u.name, role: u.role, desk: u.desk, defaultDrink: u.defaultDrink, defaultSugar: u.defaultSugar, autoBook: autoBookOn(day, u) },
    officeName: getSetting('officeName'),
    today: ctx.today,
    serverNow: ctx.nowMs,
    features: day.features,
    menu: day.menu,
    sugarOptions: day.features.sugarOptions,
    attendance: booker ? attendanceOf(day, u) : null,
    rounds: day.rounds.map(function (r) {
      return {
        id: r.id, name: r.name, serveTime: r.serveTime, cutoffTime: r.cutoffTime, cutoffAt: r.cutoffAt, locked: r.locked,
        order: booker ? orderOf(day, u, r) : null,
      };
    }),
  };
}

function book(req, user) {
  const ctx = context();
  const day = loadDay(ctx);
  const round = day.rounds.filter(function (r) { return r.id === req.roundId; })[0];
  if (!round) fail('This round no longer exists. Refresh the app.');
  if (round.locked) fail('Booking for ' + round.name + ' closed at ' + round.cutoffTime + '.', 'locked');

  if (!req.want) {
    putOrder(day, round.id, user.id, '', '', 'skipped');
    return myDay(user, ctx);
  }
  // With round changes turned off, a booking is always the person's usual drink.
  const custom = day.features.allowRoundChange;
  const drink = pickDrink(day.menu, (custom && req.drink) || user.defaultDrink);
  const sugar = pickSugar(drink, (custom && req.sugar) || user.defaultSugar, day.features);
  putOrder(day, round.id, user.id, drink.name, sugar, 'booked');
  const att = day.attendance[user.id];
  if (!att || att.status !== 'office') putAttendance(day, user.id, 'office');
  return myDay(user, ctx);
}

function setAttendance(req, user) {
  if (ATTENDANCE.indexOf(req.status) < 0) fail('Invalid status.');
  const ctx = context();
  const day = loadDay(ctx);
  if (!day.features.showAttendance) fail('Attendance is turned off by your admin.');
  putAttendance(day, user.id, req.status);
  if (req.status !== 'office') {
    // Cancel bookings for rounds that are still open.
    day.rounds.forEach(function (r) {
      const o = day.orders[r.id + '|' + user.id];
      if (!r.locked && o && o.status === 'booked') putOrder(day, r.id, user.id, o.drink, o.sugar, 'skipped');
    });
  }
  return myDay(user, ctx);
}

function savePrefs(req, user) {
  const ctx = context();
  const features = loadFeatures();
  const u = loadUsers().filter(function (x) { return x.id === user.id; })[0];
  if (req.defaultDrink !== undefined) {
    const drink = pickDrink(loadMenu().filter(function (m) { return m.active; }), req.defaultDrink);
    u.defaultDrink = drink.name;
    u.defaultSugar = pickSugar(drink, req.defaultSugar, features);
  }
  if (req.autoBook !== undefined) {
    if (req.autoBook && !features.allowAutoBook) fail('Auto-book is turned off by your admin.');
    u.autoBook = !!req.autoBook;
  }
  writeRow('Users', u._row, cells('Users', u));
  return myDay(u, ctx);
}

// ---------------------------------------------------------------- office boy

function board(req, user) {
  const ctx = context();
  finalizeDueRounds(ctx);
  return buildBoard(ctx);
}

function buildBoard(ctx) {
  const day = loadDay(ctx);
  const bookers = day.users.filter(canBook);
  const headcount = { office: 0, wfh: 0, leave: 0, unknown: 0 };
  const noReply = [];
  bookers.forEach(function (u) {
    const a = attendanceOf(day, u);
    headcount[a]++;
    if (a === 'unknown') noReply.push(u.name);
  });

  const rounds = day.rounds.map(function (r) {
    const people = [];
    let skipped = 0;
    bookers.forEach(function (u) {
      const o = orderOf(day, u, r);
      if (!o) return;
      if (o.status === 'skipped') { skipped++; return; }
      people.push({ userId: u.id, name: u.name, desk: u.desk, drink: o.drink, sugar: o.sugar, label: drinkLabel(o.drink, o.sugar), delivered: o.status === 'delivered' });
    });
    const groups = {};
    people.forEach(function (p) {
      const g = groups[p.label] || (groups[p.label] = { label: p.label, drink: p.drink, sugar: p.sugar, count: 0, delivered: 0 });
      g.count++;
      if (p.delivered) g.delivered++;
    });
    people.sort(function (a, b) { return (a.desk || '~').localeCompare(b.desk || '~') || a.name.localeCompare(b.name); });
    return {
      id: r.id, name: r.name, serveTime: r.serveTime, cutoffTime: r.cutoffTime, cutoffAt: r.cutoffAt, locked: r.locked,
      total: people.length,
      delivered: people.filter(function (p) { return p.delivered; }).length,
      skipped: skipped,
      groups: Object.keys(groups).map(function (k) { return groups[k]; })
        .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); }),
      people: people,
    };
  });

  const current = day.rounds.filter(function (r) { return ctx.nowMs < r.serveAt + 90 * 60000; })[0] || day.rounds[day.rounds.length - 1];
  return {
    officeName: getSetting('officeName'),
    today: ctx.today,
    serverNow: ctx.nowMs,
    headcount: headcount,
    noReply: day.features.showNoReply ? noReply.sort() : [],
    features: day.features,
    rounds: rounds,
    currentRoundId: current ? current.id : null,
  };
}

function deliver(req, user) {
  const ctx = context();
  const day = loadDay(ctx);
  const r = day.rounds.filter(function (x) { return x.id === req.roundId; })[0];
  const u = day.users.filter(function (x) { return x.id === req.userId; })[0];
  if (!r || !u) fail('Order not found. Refresh the list.');
  const o = orderOf(day, u, r);
  if (!o || o.status === 'skipped') fail(u.name + ' has not booked ' + r.name + '.');
  putOrder(day, r.id, u.id, o.drink, o.sugar, req.delivered ? 'delivered' : 'booked');
  return buildBoard(ctx);
}

function history(req, user) {
  if (user.role === 'officeboy' && !loadFeatures().officeBoyHistory) fail('History is turned off by your admin.', 'role');
  const ctx = context();
  finalizeDueRounds(ctx);
  const summary = summarize(ctx, shiftDate(ctx, -13), ctx.today);
  return { today: ctx.today, days: summary.days };
}

// ---------------------------------------------------------------- admin

function adminData(req, user) {
  const ctx = context();
  return {
    officeName: getSetting('officeName'),
    meId: user.id,
    users: loadUsers().map(strip),
    menu: loadMenu().map(strip),
    rounds: loadRounds(ctx).map(strip),
    sugarOptions: SUGAR_OPTIONS,
    features: loadFeatures(),
    sheetUrl: SpreadsheetApp.getActive().getUrl(),
  };
}

function saveUser(req, admin) {
  const input = req.user || {};
  const name = clean(input.name, 60);
  if (!name) fail('Name is required.');
  if (ROLES.indexOf(input.role) < 0) fail('Pick a role.');
  const existing = input.id ? loadUsers().filter(function (u) { return u.id === input.id; })[0] : null;
  if (input.id && !existing) fail('Person not found. Refresh the list.');
  const active = input.active === undefined ? true : !!input.active;
  if (existing && existing.id === admin.id && (input.role !== 'admin' || !active)) fail('You can’t remove your own admin access.');

  const u = existing || newUser({});
  u.name = name;
  u.role = input.role;
  u.desk = clean(input.desk, 40);
  u.active = active;
  if (existing) writeRow('Users', u._row, cells('Users', u));
  else appendRows('Users', [cells('Users', u)]);
  return adminData(req, admin);
}

function resetLink(req, admin) {
  const u = loadUsers().filter(function (x) { return x.id === req.userId; })[0];
  if (!u) fail('Person not found. Refresh the list.');
  u.token = newToken();
  writeRow('Users', u._row, cells('Users', u));
  const data = adminData(req, admin);
  data.ownToken = u.id === admin.id ? u.token : null;
  return data;
}

function saveSettings(req, admin) {
  const officeName = clean(req.officeName, 60);
  if (!officeName) fail('Office name is required.');

  const seen = {};
  const menu = (req.menu || []).map(function (m) {
    return { name: clean(m.name, 40), hasSugar: !!m.hasSugar, active: m.active !== false };
  }).filter(function (m) {
    const key = m.name.toLowerCase();
    if (!m.name || seen[key]) return false;
    return (seen[key] = true);
  });
  if (!menu.some(function (m) { return m.active; })) fail('Keep at least one active drink on the menu.');

  const ids = {};
  const rounds = (req.rounds || []).map(function (r) {
    const name = clean(r.name, 40);
    if (!name) fail('Every round needs a name.');
    const serveTime = validTime(r.serveTime);
    const cutoffTime = validTime(r.cutoffTime);
    if (!serveTime || !cutoffTime) fail('Set a serve time and a booking cutoff for ' + name + '.');
    if (cutoffTime > serveTime) fail(name + ': booking cutoff must be before the serve time.');
    let id = clean(r.id, 40) || slug(name) + '-' + newId().slice(0, 4);
    while (ids[id]) id += '-' + newId().slice(0, 2);
    ids[id] = true;
    return { id: id, name: name, serveTime: serveTime, cutoffTime: cutoffTime, active: r.active !== false };
  });
  if (!rounds.some(function (r) { return r.active; })) fail('Keep at least one active round.');

  setSetting('officeName', officeName);
  if (req.features) setSetting('features', JSON.stringify(cleanFeatures(req.features)));
  replaceTable('Menu', menu.map(function (m) { return cells('Menu', m); }));
  replaceTable('Rounds', rounds.map(function (r) { return cells('Rounds', r); }));
  return adminData(req, admin);
}

function report(req, user) {
  const from = String(req.from || '');
  const to = String(req.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) fail('Pick a valid date range.');
  const ctx = context();
  finalizeDueRounds(ctx);
  return summarize(ctx, from, to);
}

function summarize(ctx, from, to) {
  const names = {};
  loadUsers().forEach(function (u) { names[u.id] = u.name; });
  const days = {};
  const items = {};
  const people = {};
  let totalCups = 0;
  const dayOf = function (date) {
    return days[date] || (days[date] = { date: date, cups: 0, office: {}, items: {} });
  };
  const add = function (date, userId, drink, sugar) {
    const d = dayOf(date);
    const label = drinkLabel(drink, sugar);
    d.cups++;
    d.office[userId] = true;
    d.items[label] = (d.items[label] || 0) + 1;
    items[label] = (items[label] || 0) + 1;
    people[userId] = (people[userId] || 0) + 1;
    totalCups++;
  };
  const withToday = from <= ctx.today && ctx.today <= to;
  const inRange = function (date) { return date >= from && date <= to && !(withToday && date === ctx.today); };

  readSince('Orders', from, ctx).forEach(function (o) {
    const date = toDate(o.date, ctx);
    if (inRange(date) && str(o.status) !== 'skipped' && str(o.drink)) add(date, str(o.userId), str(o.drink), str(o.sugar));
  });
  readSince('Attendance', from, ctx).forEach(function (a) {
    const date = toDate(a.date, ctx);
    if (inRange(date) && str(a.status) === 'office') dayOf(date).office[str(a.userId)] = true;
  });
  if (withToday) {
    // Today may still contain auto-bookings that are not written yet, so use the live view.
    const day = loadDay(ctx);
    day.users.filter(canBook).forEach(function (u) {
      if (attendanceOf(day, u) === 'office') dayOf(ctx.today).office[u.id] = true;
      day.rounds.forEach(function (r) {
        const o = orderOf(day, u, r);
        if (o && o.status !== 'skipped') add(ctx.today, u.id, o.drink, o.sugar);
      });
    });
  }

  const byCount = function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); };
  const officeDays = Object.keys(days).map(function (k) { return days[k]; });
  return {
    from: from,
    to: to,
    totalCups: totalCups,
    days: officeDays
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; })
      .map(function (d) { return { date: d.date, cups: d.cups, office: Object.keys(d.office).length, items: d.items }; }),
    items: Object.keys(items).map(function (k) { return { label: k, count: items[k] }; }).sort(byCount),
    people: Object.keys(people).map(function (id) { return { label: names[id] || '(removed)', count: people[id] }; }).sort(byCount),
  };
}

// ---------------------------------------------------------------- day model

function loadDay(ctx) {
  const finalized = getFinalized(ctx);
  const rounds = loadRounds(ctx).filter(function (r) { return r.active; }).map(function (r) {
    r.cutoffAt = at(ctx, ctx.today, r.cutoffTime);
    r.serveAt = at(ctx, ctx.today, r.serveTime);
    r.locked = ctx.nowMs >= r.cutoffAt;
    r.finalized = finalized.indexOf(r.id) >= 0;
    return r;
  });
  const attendance = {};
  readSince('Attendance', ctx.today, ctx).forEach(function (a) {
    if (toDate(a.date, ctx) === ctx.today) attendance[str(a.userId)] = { status: str(a.status), _row: a._row };
  });
  const orders = {};
  readSince('Orders', ctx.today, ctx).forEach(function (o) {
    if (toDate(o.date, ctx) === ctx.today) {
      orders[str(o.roundId) + '|' + str(o.userId)] = { drink: str(o.drink), sugar: str(o.sugar), status: str(o.status), _row: o._row };
    }
  });
  return {
    ctx: ctx,
    features: loadFeatures(),
    users: loadUsers().filter(function (u) { return u.active; }),
    menu: loadMenu().filter(function (m) { return m.active; }).map(strip),
    rounds: rounds,
    attendance: attendance,
    orders: orders,
  };
}

function canBook(u) {
  return u.role !== 'officeboy';
}

/** office | wfh | leave | unknown */
function attendanceOf(day, u) {
  const a = day.attendance[u.id];
  if (a) return a.status;
  if (autoBookOn(day, u)) return 'office';
  const booked = day.rounds.some(function (r) {
    const o = day.orders[r.id + '|' + u.id];
    return o && o.status !== 'skipped';
  });
  return booked ? 'office' : 'unknown';
}

/** The order that counts for this person and round, or null. `auto` = from their usual, not yet in the sheet. */
function orderOf(day, u, r) {
  const o = day.orders[r.id + '|' + u.id];
  if (o) return { drink: o.drink, sugar: o.sugar, status: o.status, auto: false };
  const a = day.attendance[u.id];
  if (a && a.status !== 'office') return null;
  if (autoBookOn(day, u) && !r.finalized) {
    return { drink: u.defaultDrink, sugar: u.defaultSugar, status: 'booked', auto: true };
  }
  return null;
}

function autoBookOn(day, u) {
  return day.features.allowAutoBook && u.autoBook && !!u.defaultDrink;
}

function loadFeatures() {
  let saved = {};
  try {
    saved = JSON.parse(getSetting('features') || '{}');
  } catch (e) {}
  return cleanFeatures(saved);
}

function cleanFeatures(input) {
  const out = {};
  Object.keys(FEATURE_DEFAULTS).forEach(function (key) {
    if (key === 'sugarOptions') {
      const wanted = Array.isArray(input.sugarOptions) ? input.sugarOptions : FEATURE_DEFAULTS.sugarOptions;
      out.sugarOptions = SUGAR_OPTIONS.filter(function (s) { return wanted.indexOf(s) >= 0; });
    } else {
      out[key] = input[key] === undefined ? FEATURE_DEFAULTS[key] : !!input[key];
    }
  });
  return out;
}

function putOrder(day, roundId, userId, drink, sugar, status) {
  const existing = day.orders[roundId + '|' + userId];
  const values = [day.ctx.today, roundId, userId, drink, sugar, status, new Date().toISOString()];
  if (existing) writeRow('Orders', existing._row, values);
  else appendRows('Orders', [values]);
}

function putAttendance(day, userId, status) {
  const existing = day.attendance[userId];
  const values = [day.ctx.today, userId, status, new Date().toISOString()];
  if (existing) writeRow('Attendance', existing._row, values);
  else appendRows('Attendance', [values]);
}

/** Writes auto-booked orders for rounds whose cutoff has passed, so reports stay correct. */
function finalizeDueRounds(ctx) {
  const pending = loadRounds(ctx).filter(function (r) {
    return r.active && ctx.nowMs >= at(ctx, ctx.today, r.cutoffTime) && getFinalized(ctx).indexOf(r.id) < 0;
  });
  if (!pending.length) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const day = loadDay(ctx);
    const due = day.rounds.filter(function (r) { return r.locked && !r.finalized; });
    const rows = [];
    const stamp = new Date().toISOString();
    due.forEach(function (r) {
      day.users.filter(canBook).forEach(function (u) {
        const o = orderOf(day, u, r);
        if (o && o.auto) rows.push([ctx.today, r.id, u.id, o.drink, o.sugar, 'booked', stamp]);
      });
    });
    appendRows('Orders', rows);
    setFinalized(ctx, getFinalized(ctx).concat(due.map(function (r) { return r.id; })));
  } finally {
    lock.releaseLock();
  }
}

function getFinalized(ctx) {
  const state = JSON.parse(PropertiesService.getScriptProperties().getProperty('finalized') || '{}');
  return state.date === ctx.today ? state.rounds : [];
}

function setFinalized(ctx, roundIds) {
  PropertiesService.getScriptProperties().setProperty('finalized', JSON.stringify({ date: ctx.today, rounds: roundIds }));
}

// ---------------------------------------------------------------- tables

function loadUsers() {
  return readTable('Users').map(function (u) {
    return {
      _row: u._row, id: str(u.id), name: str(u.name), role: str(u.role), desk: str(u.desk), token: str(u.token),
      defaultDrink: str(u.defaultDrink), defaultSugar: str(u.defaultSugar), autoBook: bool(u.autoBook),
      active: bool(u.active), createdAt: str(u.createdAt),
    };
  });
}

function loadMenu() {
  return readTable('Menu').map(function (m) {
    return { _row: m._row, name: str(m.name), hasSugar: bool(m.hasSugar), active: bool(m.active) };
  });
}

function loadRounds(ctx) {
  return readTable('Rounds').map(function (r) {
    return { _row: r._row, id: str(r.id), name: str(r.name), serveTime: toTime(r.serveTime, ctx), cutoffTime: toTime(r.cutoffTime, ctx), active: bool(r.active) };
  }).filter(function (r) { return r.serveTime && r.cutoffTime; })
    .sort(function (a, b) { return a.serveTime < b.serveTime ? -1 : 1; });
}

function newUser(fields) {
  return {
    id: newId(), name: fields.name || '', role: fields.role || 'employee', desk: fields.desk || '', token: newToken(),
    defaultDrink: '', defaultSugar: '', autoBook: false, active: true, createdAt: new Date().toISOString(),
  };
}

function getSetting(key) {
  const row = readTable('Settings').filter(function (s) { return str(s.key) === key; })[0];
  return row ? str(row.value) : '';
}

function setSetting(key, value) {
  const row = readTable('Settings').filter(function (s) { return str(s.key) === key; })[0];
  if (row) writeRow('Settings', row._row, [key, value]);
  else appendRows('Settings', [[key, value]]);
}

// ---------------------------------------------------------------- sheet helpers

const sheetCache_ = {};

function sheet(name) {
  if (sheetCache_[name]) return sheetCache_[name];
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sheetCache_[name] = sh;
    if (SEEDS[name]) appendRows(name, SEEDS[name]);
  }
  return (sheetCache_[name] = sh);
}

function readTable(name) {
  const sh = sheet(name);
  const cols = TABLES[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues()
    .map(function (v, i) { return toObj(cols, v, i + 2); })
    .filter(function (o) { return str(o[cols[0]]) !== ''; });
}

/** Rows whose first column (a date) is >= fromDate. Reads from the bottom, so it stays fast as the sheet grows. */
function readSince(name, fromDate, ctx) {
  const sh = sheet(name);
  const cols = TABLES[name];
  const found = [];
  const CHUNK = 400;
  let end = sh.getLastRow();
  while (end >= 2) {
    const start = Math.max(2, end - CHUNK + 1);
    const values = sh.getRange(start, 1, end - start + 1, cols.length).getValues();
    let reachedOlder = false;
    for (let i = values.length - 1; i >= 0; i--) {
      const date = toDate(values[i][0], ctx);
      if (!date) continue;
      if (date < fromDate) { reachedOlder = true; break; }
      found.push(toObj(cols, values[i], start + i));
    }
    if (reachedOlder) break;
    end = start - 1;
  }
  return found.reverse();
}

function writeRow(name, row, values) {
  sheet(name).getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values.map(cell)]);
}

function appendRows(name, rows) {
  if (!rows.length) return;
  const sh = sheet(name);
  const start = sh.getLastRow() + 1;
  const needed = start + rows.length - 1 - sh.getMaxRows();
  if (needed > 0) sh.insertRowsAfter(sh.getMaxRows(), needed);
  sh.getRange(start, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows.map(function (r) { return r.map(cell); }));
}

function replaceTable(name, rows) {
  const sh = sheet(name);
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, TABLES[name].length).clearContent();
  appendRows(name, rows);
}

function cells(name, obj) {
  return TABLES[name].map(function (k) { return obj[k]; });
}

function toObj(cols, values, row) {
  const o = { _row: row };
  cols.forEach(function (k, i) { o[k] = values[i]; });
  return o;
}

function strip(o) {
  const copy = {};
  Object.keys(o).forEach(function (k) { if (k !== '_row') copy[k] = o[k]; });
  return copy;
}

/** Everything is stored as plain text so Sheets never turns "10:30" into a date. */
function cell(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  const s = v === null || v === undefined ? '' : String(v);
  return s.charAt(0) === '=' ? "'" + s : s;
}

// ---------------------------------------------------------------- small utils

function context() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const now = new Date();
  return {
    tz: tz,
    nowMs: now.getTime(),
    today: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    offset: Utilities.formatDate(now, tz, 'XXX'),
  };
}

/** Epoch ms for a wall-clock time today in the sheet's time zone. */
function at(ctx, date, hhmm) {
  return new Date(date + 'T' + hhmm + ':00' + ctx.offset).getTime();
}

function shiftDate(ctx, days) {
  return Utilities.formatDate(new Date(ctx.nowMs + days * 86400000), ctx.tz, 'yyyy-MM-dd');
}

function toDate(v, ctx) {
  if (v instanceof Date) return Utilities.formatDate(v, ctx.tz, 'yyyy-MM-dd');
  return str(v);
}

function toTime(v, ctx) {
  if (v instanceof Date) return Utilities.formatDate(v, ctx.tz, 'HH:mm');
  return validTime(v);
}

function validTime(v) {
  const m = str(v).match(/^(\d{1,2}):(\d{2})/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
  return m[1].padStart(2, '0') + ':' + m[2];
}

function pickDrink(menu, name) {
  if (!name) fail('Pick a drink first.');
  const drink = menu.filter(function (m) { return m.name.toLowerCase() === String(name).toLowerCase(); })[0];
  if (!drink) fail(name + ' is not on the menu any more. Pick another drink.');
  return drink;
}

function pickSugar(drink, sugar, features) {
  const allowed = features.sugarOptions;
  if (!drink.hasSugar || !allowed.length) return '';
  return allowed.indexOf(sugar) >= 0 ? sugar : allowed[0];
}

function drinkLabel(drink, sugar) {
  if (!sugar) return drink;
  return drink + ' · ' + (sugar === 'No sugar' ? 'No sugar' : sugar + ' sugar');
}

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function bool(v) {
  return v === true || str(v).toUpperCase() === 'TRUE';
}

function clean(v, max) {
  return str(v).replace(/\s+/g, ' ').slice(0, max);
}

function slug(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'round';
}

function newId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function newToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function fail(message, code) {
  const err = new Error(message);
  err.expected = true;
  err.code = code || null;
  throw err;
}

function json(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
