// End-to-end test of apps-script/Code.gs through the mock server. No dependencies.
//   node dev/test-backend.mjs
// Starts its own mock server on a spare port with a throwaway database.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'officeboy-test-'));
const PORT = 8800 + Math.floor(Math.random() * 100);
const URL = `http://localhost:${PORT}/exec`;
const server = spawn(process.execPath, [join(ROOT, 'dev', 'mock-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), MOCK_DB: join(dir, 'db.json'), MOCK_DELAY: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.once('data', resolve));

let passed = 0;
const call = async (action, payload = {}) => {
  const res = await fetch(URL, { method: 'POST', body: JSON.stringify({ action, ...payload }) });
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(`${action}: ${body.error}`), { code: body.code });
  return body.data;
};
const ok = (cond, label) => {
  if (!cond) throw new Error(`FAILED: ${label}`);
  passed++;
};
const rejects = async (action, payload, pattern, label) => {
  try {
    await call(action, payload);
  } catch (err) {
    ok(pattern.test(err.message), `${label} (got "${err.message}")`);
    return;
  }
  throw new Error(`FAILED: ${label} (no error)`);
};

try {
  // ---------- setup & login
  ok((await call('status')).configured === false, 'fresh sheet is not configured');
  const { token: admin } = await call('setup', { officeName: 'Acme', adminName: 'Asha', password: 'secret1' });
  await rejects('setup', { officeName: 'x', adminName: 'y', password: 'secret1' }, /already/, 'setup only once');
  await rejects('adminLogin', { password: 'nope' }, /Wrong/, 'wrong password rejected');
  ok((await call('adminLogin', { password: 'secret1' })).token === admin, 'admin login returns admin token');

  // ---------- people
  let ad = await call('adminData', { token: admin });
  for (const [name, role, desk] of [['Ravi', 'employee', '2F-12'], ['Sunil', 'officeboy', ''], ['Meera', 'employee', '1F-03']]) {
    ad = await call('saveUser', { token: admin, user: { name, role, desk } });
  }
  const user = (name) => ad.users.find((u) => u.name === name);
  await rejects('saveUser', { token: admin, user: { id: ad.meId, name: 'Asha', role: 'employee' } }, /own admin/, 'admin cannot demote self');

  // ---------- rounds: one closed, one open
  ad = await call('saveSettings', {
    token: admin, officeName: 'Acme', menu: ad.menu,
    rounds: [{ name: 'Early', serveTime: '00:05', cutoffTime: '00:01' }, { name: 'Late', serveTime: '23:59', cutoffTime: '23:58' }],
  });
  const early = ad.rounds.find((r) => r.name === 'Early').id;
  const late = ad.rounds.find((r) => r.name === 'Late').id;

  // ---------- booking
  let me = await call('me', { token: user('Ravi').token });
  ok(me.rounds.find((r) => r.id === early).locked, 'past cutoff is locked');
  await rejects('book', { token: user('Ravi').token, roundId: late, want: true }, /Pick a drink/, 'booking needs a drink');
  me = await call('book', { token: user('Ravi').token, roundId: late, want: true, drink: 'tea', sugar: 'Less' });
  ok(me.rounds.find((r) => r.id === late).order.drink === 'Tea' && me.attendance === 'office', 'booking sets drink and attendance');
  await rejects('book', { token: user('Ravi').token, roundId: early, want: true, drink: 'Tea' }, /closed/, 'locked round rejects booking');
  me = await call('savePrefs', { token: user('Meera').token, defaultDrink: 'Green tea', autoBook: true });
  ok(me.rounds.find((r) => r.id === late).order.auto, 'auto-book shows as booked');
  await rejects('board', { token: user('Ravi').token }, /role/, 'employee cannot see board');
  let board = await call('board', { token: user('Sunil').token });
  ok(board.rounds.find((r) => r.id === late).total === 2, 'board counts both orders');
  board = await call('deliver', { token: user('Sunil').token, roundId: late, userId: user('Meera').id, delivered: true });
  ok(board.rounds.find((r) => r.id === late).delivered === 1, 'delivery recorded');
  me = await call('setAttendance', { token: user('Ravi').token, status: 'wfh' });
  ok(me.rounds.find((r) => r.id === late).order.status === 'skipped', 'WFH cancels open booking');
  const report = await call('report', { token: admin, from: '2020-01-01', to: '2099-12-31' });
  ok(report.totalCups === 1, 'report counts delivered cup');

  // ---------- admin show/hide options
  ad = await call('saveSettings', {
    token: admin, officeName: 'Acme', menu: ad.menu, rounds: ad.rounds,
    features: { sugarOptions: ['No sugar'], showAttendance: false, allowAutoBook: false, allowRoundChange: false, showNoReply: false, officeBoyHistory: false },
  });
  await rejects('setAttendance', { token: user('Meera').token, status: 'wfh' }, /turned off/, 'hidden attendance is blocked');
  await rejects('savePrefs', { token: user('Meera').token, autoBook: true }, /turned off/, 'hidden auto-book is blocked');
  me = await call('savePrefs', { token: user('Meera').token, defaultDrink: 'Tea', defaultSugar: 'Less' });
  ok(me.user.defaultSugar === 'No sugar', 'sugar limited to allowed options');
  me = await call('book', { token: user('Meera').token, roundId: late, want: true, drink: 'Coffee' });
  ok(me.rounds.find((r) => r.id === late).order.drink === 'Tea', 'per-round change ignored when off');
  await rejects('history', { token: user('Sunil').token }, /turned off/, 'office boy history hidden');
  ad = await call('saveSettings', { token: admin, officeName: 'Acme', menu: ad.menu, rounds: ad.rounds, features: {} });
  ok(ad.features.callReasons.length === 6, 'features reset to defaults');

  // ---------- calls
  const meera = user('Meera');
  await rejects('call', { token: meera.token, reason: 'Tea' }, /turned on calling/, 'calling needs permission');
  ad = await call('saveUser', { token: admin, user: { ...meera, title: 'CEO', desk: 'Cabin 1', canCall: true } });
  me = await call('me', { token: meera.token });
  ok(me.user.canCall && me.user.title === 'CEO', 'me returns call permission and title');
  await rejects('call', { token: meera.token, reason: 'Pizza' }, /Pick what/, 'unknown reason rejected');
  let mine = await call('call', { token: meera.token, reason: 'Tea', note: '2 guests' });
  ok(mine.calls[0].status === 'open' && mine.push.reason === 'not-configured', 'call placed without Firebase');
  let calls = await call('calls', { token: user('Sunil').token });
  ok(calls.calls[0].from.title === 'CEO' && calls.calls[0].note === '2 guests', 'office boy sees caller details');
  const same = await call('calls', { token: user('Sunil').token, since: calls.version });
  ok(same.unchanged, 'unchanged calls return a short reply');
  await rejects('calls', { token: meera.token }, /role/, 'caller cannot see all calls');
  calls = await call('updateCall', { token: user('Sunil').token, id: calls.calls[0].id, status: 'coming' });
  ok(calls.calls[0].status === 'coming' && calls.calls[0].handledBy === 'Sunil', 'office boy marks coming');
  mine = await call('myCalls', { token: meera.token });
  ok(mine.calls[0].status === 'coming' && mine.calls[0].handledBy === 'Sunil', 'caller sees who is coming');
  calls = await call('updateCall', { token: user('Sunil').token, id: mine.calls[0].id, status: 'done' });
  mine = await call('call', { token: meera.token, reason: 'Water' });
  mine = await call('cancelCall', { token: meera.token, id: mine.calls[0].id });
  ok(mine.calls[0].status === 'cancelled', 'caller can cancel');
  await call('call', { token: meera.token, reason: 'Tea' });
  await call('call', { token: meera.token, reason: 'Tea' });
  await call('call', { token: meera.token, reason: 'Tea' });
  await rejects('call', { token: meera.token, reason: 'Tea' }, /3 calls/, 'max 3 waiting calls');

  // ---------- Firebase push (UrlFetchApp is faked by the mock)
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const firebase = {
    config: { apiKey: 'AIzaTest', projectId: 'acme-tea', messagingSenderId: '123', appId: '1:123:web:abc' },
    vapidKey: 'B' + 'x'.repeat(86),
  };
  await rejects('saveFirebase', { token: admin, ...firebase, serviceAccount: JSON.stringify({ client_email: 'a@b', private_key: privateKey, project_id: 'other' }) }, /belongs to project/, 'project mismatch rejected');
  ad = await call('saveFirebase', { token: admin, ...firebase, serviceAccount: JSON.stringify({ client_email: 'push@acme-tea.iam', private_key: privateKey, project_id: 'acme-tea' }) });
  ok(ad.firebase.ready && ad.pushServiceAccount === 'push@acme-tea.iam' && !JSON.stringify(ad).includes('PRIVATE KEY'), 'Firebase saved, private key never returned');
  me = await call('me', { token: user('Sunil').token });
  ok(me.firebase.vapidKey === firebase.vapidKey && !('private_key' in me.firebase), 'public Firebase config reaches the app');
  await call('registerDevice', { token: user('Sunil').token, deviceToken: 'fcm-token-'.padEnd(40, 'x'), platform: 'android' });
  await call('cancelCall', { token: meera.token, id: (await call('myCalls', { token: meera.token })).calls[0].id });
  mine = await call('call', { token: meera.token, reason: 'Coffee' });
  ok(mine.push.sent === 1, 'call pushes to the office boy device');
  ok((await call('testPush', { token: admin, target: 'officeboys' })).sent === 1, 'admin test push reaches office boy');

  console.log(`\n✓ ${passed} checks passed`);
} catch (err) {
  console.error(`\n✗ ${err.message}\n  (${passed} checks passed before this)`);
  process.exitCode = 1;
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
