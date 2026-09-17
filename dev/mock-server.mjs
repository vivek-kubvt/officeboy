// Local stand-in for Google Apps Script so the app can be developed without a Google account.
// Runs apps-script/Code.gs against an in-memory "spreadsheet" and serves docs/ as the PWA.
//
//   node dev/mock-server.mjs            → http://localhost:8787
//   MOCK_TZ=Europe/London PORT=9000 node dev/mock-server.mjs
//
// In the app's setup screen paste http://localhost:8787/exec as the web app URL.
// Data is kept in dev/.mock-db.json (delete it to start over).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = process.env.MOCK_DB || join(ROOT, 'dev', '.mock-db.json');
const PORT = Number(process.env.PORT || 8787);
const TZ = process.env.MOCK_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : { sheets: {}, props: {} };
const save = () => writeFileSync(DB_FILE, JSON.stringify(db, null, 1));

// ------------------------------------------------------------------ fake Apps Script services

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      out.push(Array.from({ length: this.cols }, (_, c) => src[this.col - 1 + c] ?? ''));
    }
    return out;
  }
  setValues(values) {
    if (this.row + this.rows - 1 > this.sheet.maxRows) throw new Error('Range out of bounds (mock)');
    values.forEach((vals, r) => {
      const target = (this.sheet.data[this.row - 1 + r] ||= []);
      vals.forEach((v, c) => { target[this.col - 1 + c] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v; });
    });
    for (let i = 0; i < this.sheet.data.length; i++) this.sheet.data[i] ||= [];
    return this;
  }
  clearContent() { return this.setValues(Array.from({ length: this.rows }, () => Array(this.cols).fill(''))); }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.store = (db.sheets[name] ||= { data: [], maxRows: 1000 });
  }
  get data() { return this.store.data; }
  get maxRows() { return this.store.maxRows; }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((v) => v !== '' && v != null)) return i + 1;
    return 0;
  }
  getMaxRows() { return this.store.maxRows; }
  insertRowsAfter(_, n) { this.store.maxRows += n; }
  getRange(row, col, rows = 1, cols = 1) { return new Range(this, row, col, rows, cols); }
  setFrozenRows() {}
}

function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
      .formatToParts(date).map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? 'Z' : parts.timeZoneName.replace('GMT', '');
  return pattern.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('XXX', offset);
}

const cache = new Map();
const services = {
  SpreadsheetApp: {
    getActive: () => ({
      getSheetByName: (name) => (db.sheets[name] ? new Sheet(name) : null),
      insertSheet: (name) => new Sheet(name),
      getSpreadsheetTimeZone: () => TZ,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/mock-sheet',
    }),
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, value) => [...createHash(alg).update(value, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => randomUUID(),
    formatDate,
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => db.props[k] ?? null,
      setProperty: (k, v) => { db.props[k] = String(v); },
      setProperties: (o) => Object.entries(o).forEach(([k, v]) => { db.props[k] = String(v); }),
    }),
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => cache.get(k) ?? null,
      put: (k, v) => cache.set(k, v),
      remove: (k) => cache.delete(k),
    }),
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  },
  ScriptApp: {
    getProjectTriggers: () => [],
    newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
  },
  console,
};

function runScript(fnName, arg) {
  // Fresh context per request, like Apps Script (module-level caches reset each execution).
  const context = vm.createContext({ ...services });
  vm.runInContext(readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), context, { filename: 'Code.gs' });
  const result = context[fnName](arg);
  save();
  return result;
}

// ------------------------------------------------------------------ HTTP

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/exec') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET') return res.end(runScript('doGet').text);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const delay = Number(process.env.MOCK_DELAY || 400); // Apps Script is not instant; keep the UI honest.
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(runScript('doPost', { postData: { contents: body } }).text);
      }, delay);
    });
    return;
  }
  const file = normalize(join(ROOT, 'docs', url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(join(ROOT, 'docs')) || !existsSync(file) || statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.end(readFileSync(file));
}).listen(PORT, () => {
  console.log(`OfficeBoy mock running: http://localhost:${PORT}  (time zone ${TZ})`);
  console.log(`Web app URL for setup: http://localhost:${PORT}/exec`);
});
