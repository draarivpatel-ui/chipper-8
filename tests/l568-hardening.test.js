'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Chip8 = require('../engine.js');
const Studio = require('../studio.js');
const sha256 = require('../sha256.js');
const { assemble } = require('../assembler.js');
const { boot } = require('./dom-harness.cjs');

const repo = path.join(__dirname, '..');
const scripts = ['engine.js', 'assembler.js', 'roms.js', 'clock.js', 'sha256.js', 'studio.js', 'app.js'];
function app() { return boot(repo, scripts); }
function machineWith(rom) { const c = new Chip8(); c.load(rom); return c; }

test('sha256 rejects malformed byte array values instead of coercing them', () => {
  for (const input of [[256], [-1], [1.5], [NaN], [Infinity], [undefined], [null]]) {
    assert.throws(() => sha256(input), TypeError, JSON.stringify(input));
  }
  for (const input of [{ length: 1.5 }, { length: -1 }, { length: 1, 0: 256 }]) {
    assert.throws(() => sha256(input), TypeError);
  }
});

test('audit builder honors traceSteps including an explicit zero', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = Studio.buildAudit(machineWith(rom), rom, { traceSteps: 8 });
  assert.equal(report.trace.stepsRequested, 8);
  assert.equal(report.trace.entries.length, 8);
  const zero = Studio.buildAudit(machineWith(rom), rom, { traceSteps: 0 });
  assert.equal(zero.trace.stepsRequested, 0);
  assert.equal(zero.trace.entries.length, 0);
});

test('audit builder rejects malformed ROM bytes instead of zeroing them', () => {
  assert.throws(() => Studio.buildAudit(new Chip8(), [0x60, 256], { traceSteps: 0 }), TypeError);
  assert.throws(() => Studio.buildAudit(new Chip8(), [0x60, 1.5], { traceSteps: 0 }), TypeError);
});

test('CSV escaping catches formula injection after leading whitespace', () => {
  assert.equal(Studio.csvCell('  =cmd'), "'  =cmd");
  assert.equal(Studio.csvCell(' \t+HYPERLINK("x")'), `"' \t+HYPERLINK(""x"")"`);
});

test('bookmark codec rejects duplicate keys and out-of-range clock rates', () => {
  assert.equal(Studio.decodeBookmark('#c8=p=vip;p=modern;d=1'), null);
  assert.equal(Studio.decodeBookmark('#c8=p=vip;d=1;d=2'), null);
  assert.equal(Studio.decodeBookmark('#c8=p=vip;hz=59'), null);
  assert.equal(Studio.decodeBookmark('#c8=p=vip;hz=2001'), null);
});

test('bookmark encoder validates profile, dips, speed and ROM fields', () => {
  assert.throws(() => Studio.encodeBookmark({ profile: 'nope' }), RangeError);
  assert.throws(() => Studio.encodeBookmark({ profile: 'vip', dips: 8 }), RangeError);
  assert.throws(() => Studio.encodeBookmark({ profile: 'vip', dips: -1 }), RangeError);
  assert.throws(() => Studio.encodeBookmark({ profile: 'vip', speed: 59 }), RangeError);
  assert.throws(() => Studio.encodeBookmark({ profile: 'vip', speed: 2001 }), RangeError);
  assert.throws(() => Studio.encodeBookmark({ profile: 'vip', rom: -1 }), RangeError);
  assert.throws(() => Studio.encodeBookmark({ profile: 'vip', rom: 1.5 }), RangeError);
});

test('snapshot restore rejects severity values the live machine cannot produce', () => {
  const c = new Chip8();
  c.load([0x01, 0x23]);
  c.step();
  c.diagnostics[0].severity = 'fatal';
  const snap = c.snapshotState();
  assert.throws(() => new Chip8().restoreState(snap), /severity/);
});

test('snapshot restore rejects inconsistent key-wait state', () => {
  const c = new Chip8();
  c.load([0x60, 0x00]);
  c.waitKey = 3;
  assert.throws(() => new Chip8().restoreState(c.snapshotState()), /key wait/i);

  const mismatch = new Chip8();
  mismatch.load([0x60, 0x00]);
  mismatch.waitingForKey = 2;
  mismatch.waitKey = 3;
  mismatch.releasedKey = 4;
  assert.throws(() => new Chip8().restoreState(mismatch.snapshotState()), /key wait/i);
});

test('binary ROM strings reject code points above byte range', () => {
  assert.throws(() => new Chip8().load('\u0100'), RangeError);
  const lint = Chip8.validateRom('\u0100');
  assert.equal(lint.ok, false);
  assert.ok(lint.diagnostics.some(d => d.code === 'BAD_BYTE' && d.severity === 'error'));
});

test('one-operand shifts encode the source register as the destination', () => {
  assert.deepEqual(Array.from(assemble('SHR V4')), [0x84, 0x46]);
  assert.deepEqual(Array.from(assemble('SHL V4')), [0x84, 0x4E]);
  const c = new Chip8().setProfile('vip');
  c.load(assemble('LD V0,3\nLD V4,0x25\nSHR V4'));
  c.step(); c.step(); c.step();
  assert.equal(c.V[4], 0x12);
  assert.equal(c.V[0xF], 1);
});

test('audit replay reports malformed input without throwing', () => {
  let result;
  assert.doesNotThrow(() => { result = Studio.replayAudit('{not json'); });
  assert.equal(result.ok, false);
  assert.doesNotThrow(() => { result = Studio.replayAudit({ format: 'chipper8-audit' }); });
  assert.equal(result.ok, false);
});

test('hex keypad exposes group semantics and tables use scoped headers', () => {
  const h = app();
  assert.equal(h.node('keypad').getAttribute('role'), 'group');
  const headers = h.document.querySelectorAll('th').filter(th => th.parentNode.parentNode.tagName === 'THEAD');
  assert.ok(headers.length >= 11);
  for (const th of headers) {
    assert.equal(th.getAttribute('scope'), 'col');
  }
  for (const row of h.node('quirkMatrixBody').children) {
    assert.equal(row.children[0].getAttribute('scope'), 'row');
  }
});

test('light theme accent text meets WCAG AA contrast on workbench panels', () => {
  const css = fs.readFileSync(path.join(repo, 'style.css'), 'utf8');
  const vars = {};
  for (const block of css.matchAll(/html\[data-theme="light"\]\s*\{([^}]*)\}/g)) {
    for (const v of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
  }
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [16, 8, 0].map(shift => {
      const x = ((n >> shift) & 255) / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function ratio(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  assert.ok(ratio(vars['--accent'], vars['--panel-deep']) >= 4.5, ratio(vars['--accent'], vars['--panel-deep']).toFixed(2));
  assert.ok(ratio(vars['--accent'], vars['--panel']) >= 4.5, ratio(vars['--accent'], vars['--panel']).toFixed(2));
});


test('faint text tokens meet WCAG AA contrast on every themed panel', () => {
  const css = fs.readFileSync(path.join(repo, 'style.css'), 'utf8');
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [16, 8, 0].map(shift => {
      const x = ((n >> shift) & 255) / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function ratio(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  for (const theme of ['amber', 'green', 'light']) {
    const match = css.match(new RegExp('html\\[data-theme="' + theme + '"\\]\\s*\\{([^}]*)\\}'));
    assert.ok(match, theme + ' theme exists');
    const vars = {};
    for (const v of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    for (const surface of ['--panel', '--panel-alt', '--panel-deep']) {
      const actual = ratio(vars['--text-faint'], vars[surface]);
      assert.ok(actual >= 4.5, theme + ' ' + surface + ' contrast ' + actual.toFixed(2));
    }
  }
});

test('browser audit transport does not leave stderr as an undrained pipe', () => {
  const script = fs.readFileSync(path.join(repo, 'scripts/audit-headless.mjs'), 'utf8');
  assert.match(script, /stdio:\s*\[\s*'ignore',\s*'ignore',\s*'ignore',\s*'pipe',\s*'pipe'\s*\]/);
});
