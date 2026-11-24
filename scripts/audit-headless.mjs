#!/usr/bin/env node
/*
 * chipper-8 real-browser audit - zero dependencies.
 *
 * Drives the Chromium headless shell that is already installed on this
 * machine (Playwright's cache) over raw CDP on --remote-debugging-pipe:
 * file descriptors 3 (write) and 4 (read), NUL-delimited JSON messages.
 * No npm packages are needed and nothing is added to package.json.
 *
 * Checks, at each viewport (1440x900 and 390x844):
 *   - 0 console errors and 0 uncaught page errors
 *   - 0 external network requests (every URL must be file://)
 *   - 0 horizontal overflow
 *   - quirk switcher + live matrix column
 *   - step / step-back controls
 *   - opcode-family coverage SVG
 *   - self-test runner
 *   - checksummed audit exports + tamper verification
 *   - URL-hash bookmarking
 *
 * Usage: node scripts/audit-headless.mjs [--screens-dir <dir>]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + path.join(repo, 'index.html');
const args = process.argv.slice(2);
const screensDir = args.includes('--screens-dir') ? args[args.indexOf('--screens-dir') + 1] : null;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const BIN = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!BIN) {
  console.error('FAIL: no Chromium binary found. Set CHROME_PATH.');
  process.exit(1);
}

/* ---------------------------------------------------------- CDP transport */
function cdpSession(width, height) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-audit-'));
  const chrome = spawn(BIN, [
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--user-data-dir=' + profile,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  const out = chrome.stdio[3];   // us -> browser
  const inp = chrome.stdio[4];   // browser -> us
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const waiters = [];

  inp.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let idx;
    while ((idx = buffer.indexOf(0)) !== -1) {
      const raw = buffer.slice(0, idx).toString('utf8');
      buffer = buffer.slice(idx + 1);
      if (!raw.trim()) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.method + ': ' + JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method) {
        events.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].test(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
        }
      }
    }
  });

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    out.write(JSON.stringify(msg) + '\0');
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 30000);
    });
  }

  function waitEvent(test, ms = 15000) {
    for (const e of events) if (test(e)) return Promise.resolve(e);
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i !== -1) { waiters.splice(i, 1); reject(new Error('event timeout')); }
      }, ms);
    });
  }

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  chrome.on('error', () => cleanup());
  return { send, waitEvent, events, cleanup };
}

/* ------------------------------------------------------------- check kit */
const results = [];
const check = (viewport, name, pass, detail = '') => {
  results.push({ viewport, name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${viewport}] ${name}${detail ? ' - ' + detail : ''}`);
};

async function evaluate(send, sid, expression) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error('page eval threw: ' + (e.exception?.description || e.text));
  }
  return r.result?.value;
}

async function auditViewport(width, height, url) {
  const tag = `${width}x${height}`;
  console.log(`\n== viewport ${tag} ==`);
  const { send, waitEvent, events, cleanup } = cdpSession(width, height);
  const sessionTag = tag;
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sid);
    await send('Runtime.enable', {}, sid);
    await send('Log.enable', {}, sid);
    await send('Network.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 500,
    }, sid);

    const loaded = waitEvent(e => e.method === 'Page.loadEventFired' && e.sessionId === sid);
    await send('Page.navigate', { url }, sid);
    await loaded;
    await new Promise(r => setTimeout(r, 400)); // let boot + first paints settle

    // ---- 1. console errors / page errors / external requests ----
    const consoleErrors = events.filter(e =>
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' && e.sessionId === sid) ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && e.sessionId === sid &&
        !/favicon|net::ERR_FILE_NOT_FOUND.*favicon/.test(e.params.entry.text || '')));
    const pageErrors = events.filter(e => e.method === 'Runtime.exceptionThrown' && e.sessionId === sid);
    const external = events.filter(e =>
      e.method === 'Network.requestWillBeSent' && e.sessionId === sid &&
      !e.params.request.url.startsWith('file://'));
    check(sessionTag, 'console.errors', consoleErrors.length === 0, `${consoleErrors.length} console error(s)`);
    check(sessionTag, 'page.errors', pageErrors.length === 0, `${pageErrors.length} uncaught error(s)`);
    check(sessionTag, 'network.external', external.length === 0,
      external.length ? external.map(e => e.params.request.url).join(', ') : 'all requests local file://');

    // ---- 2. layout: no horizontal overflow ----
    const overflow = await evaluate(send, sid,
      `Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) - document.documentElement.clientWidth`);
    check(sessionTag, 'layout.noHOverflow', overflow <= 0, `overflow ${overflow}px`);

    // ---- 3. hero/title integrity (no eyebrow under/over the title) ----
    const titleOk = await evaluate(send, sid,
      `document.querySelector('.eyebrow') === null && !!document.querySelector('h1')`);
    check(sessionTag, 'title.clean', titleOk, 'no eyebrow/tagline elements');

    // ---- 11. deep-link application (hash runs only; before any mutation) ----
    if (url.includes('#c8=')) {
      const applied = await evaluate(send, sid, `(() => ({
        profile: document.getElementById('profileSelect').value,
        dips: [document.getElementById('quirkLoadStore').checked,
               document.getElementById('quirkShiftVy').checked,
               document.getElementById('quirkJumpVx').checked],
        speed: document.getElementById('speedValue').textContent,
      }))()`);
      check(sessionTag, 'bookmark.apply',
        applied.profile === 'vip' &&
        applied.dips.every(Boolean) &&
        applied.speed === '120 Hz',
        `profile=${applied.profile} dips=${applied.dips} speed=${applied.speed}`);
    }

    // ---- 4. quirk switcher + live matrix ----
    const matrixRows = await evaluate(send, sid, `document.getElementById('quirkMatrixBody').children.length`);
    const probeText = await evaluate(send, sid, `document.getElementById('quirkLive').textContent`);
    check(sessionTag, 'quirk.matrix', matrixRows === 6, `${matrixRows} rows`);
    check(sessionTag, 'quirk.probes', /DIVERGES/.test(probeText), 'executed probes show divergence');
    const vipLive = await evaluate(send, sid, `(() => {
      const sel = document.getElementById('profileSelect');
      sel.value = 'vip'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      return [...document.getElementById('quirkMatrixBody').children]
        .find(r => r.children[0].textContent.includes('SHIFTS')).children[4].textContent;
    })()`);
    check(sessionTag, 'quirk.switcher', vipLive === 'ON', `vip SHIFTS live cell = ${vipLive}`);
    await evaluate(send, sid, `(() => {
      const sel = document.getElementById('profileSelect');
      sel.value = 'modern'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1;
    })()`);

    // ---- 5. step / step-back / ring depth ----
    const opAfterSteps = await evaluate(send, sid, `(() => {
      document.getElementById('stepBtn').click();
      document.getElementById('stepBtn').click();
      return document.getElementById('opCount').textContent;
    })()`);
    check(sessionTag, 'step.forward', Number(opAfterSteps) >= 1, `opCount=${opAfterSteps}`);
    const depth = await evaluate(send, sid, `document.getElementById('timeDepth').textContent`);
    check(sessionTag, 'time.depth', depth === `${Number(opAfterSteps)} / 256 captured`, depth);
    const rewound = await evaluate(send, sid, `(() => {
      const before = document.getElementById('opCount').textContent;
      document.getElementById('stepBackBtn').click();
      return { before, ops: document.getElementById('opCount').textContent,
               cov: document.getElementById('coverageTotal').textContent,
               pc: [...document.getElementById('stateGrid').children].find(c => c.textContent.startsWith('PC'))?.querySelector('.v').textContent };
    })()`);
    check(sessionTag, 'step.back',
      Number(rewound.ops) === Number(rewound.before) - 1 && Number(rewound.cov) === Number(rewound.ops),
      `pc=${rewound.pc} ops=${rewound.before}->${rewound.ops} coverage=${rewound.cov}`);

    // ---- 6. coverage SVG ----
    const cov = await evaluate(send, sid, `(() => ({
      groups: document.getElementById('coverageSvg').children.length,
      total: document.getElementById('coverageTotal').textContent,
      note: document.getElementById('coverageNote').textContent
    }))()`);
    check(sessionTag, 'coverage.svg', cov.groups === 16 && Number(cov.total) >= 1, `${cov.groups} cells, ${cov.total} ops`);

    // ---- 7. multi-breakpoint parse ----
    const bpStatus = await evaluate(send, sid, `(() => {
      document.getElementById('breakpointInput').value = '0x200, 0x20A';
      document.getElementById('breakpointBtn').click();
      return document.getElementById('breakpointStatus').textContent;
    })()`);
    check(sessionTag, 'breakpoints.multi', /0x200, 0x20A/.test(bpStatus), bpStatus.slice(0, 60));
    await evaluate(send, sid, `(() => {
      document.getElementById('breakpointInput').value = '';
      document.getElementById('breakpointBtn').click(); return 1;
    })()`);

    // ---- 8. self-test runner ----
    const st = await evaluate(send, sid, `(() => {
      document.getElementById('selfTestBtn').click();
      return { summary: document.getElementById('selfTestSummary').textContent,
               fails: document.querySelectorAll('#selfTestList .st-fail').length,
               rows: document.getElementById('selfTestList').children.length };
    })()`);
    check(sessionTag, 'selftests.run', st.fails === 0 && st.rows >= 16, st.summary);

    // ---- 9. checksummed exports + tamper verification ----
    const auditJson = await evaluate(send, sid, `(() => {
      document.getElementById('auditJsonBtn').click();
      const ex = window.__c8LastExport;
      const r = JSON.parse(ex.text);
      return { name: ex.filename, format: r.format, digest: r.digest.value,
               honest: /unkeyed/i.test(r.integrity.note) };
    })()`);
    check(sessionTag, 'audit.json', auditJson.format === 'chipper8-audit' && /^[0-9a-f]{64}$/.test(auditJson.digest) && auditJson.honest,
      auditJson.digest.slice(0, 20) + '… unkeyed=' + auditJson.honest);
    const auditCsv = await evaluate(send, sid, `(() => {
      document.getElementById('auditCsvBtn').click();
      const ex = window.__c8LastExport;
      const first = ex.text.split(/\\r?\\n/)[0];
      return { name: ex.filename, head: first, ok: /^[0-9a-f]{64}$/.test(first.split(',')[3] || '') };
    })()`);
    check(sessionTag, 'audit.csv', auditCsv.name === 'chipper8-audit.csv' && auditCsv.ok, auditCsv.head.slice(0, 48));
    const auditMd = await evaluate(send, sid, `(() => {
      document.getElementById('auditMdBtn').click();
      return /Unkeyed SHA-256 tamper-detection digest/.test(window.__c8LastExport.text);
    })()`);
    check(sessionTag, 'audit.md', auditMd === true, 'honest label present');
    const verify = await evaluate(send, sid, `(() => {
      document.getElementById('auditVerifyBtn').click();
      const lines = document.getElementById('auditStatus').textContent.split('\\n');
      return { all: lines.every(l => l.startsWith('PASS')), n: lines.length,
               tamper: lines.some(l => /tamper detected/.test(l)) };
    })()`);
    check(sessionTag, 'audit.verify', verify.all && verify.tamper, `${verify.n} checks incl. forged-entry tamper catch`);

    // ---- 10. URL-hash bookmark written by the app ----
    const hash = await evaluate(send, sid, `location.hash`);
    check(sessionTag, 'bookmark.hash', /^#c8=p=[a-z0-9]+;d=\d;hz=\d+;r=\d+$/.test(hash), hash);
  } finally {
    cleanup();
  }
}

async function screenshotAt(width, height, file) {
  const { send, waitEvent, cleanup } = cdpSession(width, height);
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }, sid);
    const loaded = waitEvent(e => e.method === 'Page.loadEventFired' && e.sessionId === sid);
    await send('Page.navigate', { url: PAGE }, sid);
    await loaded;
    await evaluate(send, sid, `document.getElementById('selfTestBtn').click()`);
    for (let i = 0; i < 5; i++) await evaluate(send, sid, `document.getElementById('stepBtn').click()`);
    await new Promise(r => setTimeout(r, 400));
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${file}`);
  } finally {
    cleanup();
  }
}

const VIEWPORTS = [[1440, 900], [390, 844]];
for (const [w, h] of VIEWPORTS) {
  await auditViewport(w, h, PAGE);
}
// Deep-link check: boot the page with a bookmark hash and verify it applied.
await auditViewport(1440, 900, PAGE + '#c8=p=vip;d=7;hz=120;r=1');

if (screensDir) {
  fs.mkdirSync(screensDir, { recursive: true });
  for (const [w, h] of VIEWPORTS) {
    await screenshotAt(w, h, path.join(screensDir, `chipper8-${w}x${h}.png`));
  }
}

const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass).length;
console.log(`\n==== audit summary: ${pass}/${results.length} checks passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
