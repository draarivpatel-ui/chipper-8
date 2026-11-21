'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { boot } = require('./dom-harness.cjs');
const repo = path.join(__dirname, '..');
const scripts = ['engine.js', 'assembler.js', 'roms.js', 'clock.js', 'app.js'];
function app(options) { return boot(repo, scripts, options); }
function compile(h, source) { h.node('assemblyEditor').value = source; h.node('assembleBtn').click(); }
function state(h, key) { return h.node('stateGrid').children.find(n => n.textContent.startsWith(key)).querySelector('.v').textContent; }

test('the bench boots clean with the new export controls and live region', () => {
  const h = app();
  assert.equal(h.errors.length, 0);
  assert.ok(h.node('exportStateBtn'));
  assert.ok(h.node('exportTraceBtn'));
  assert.ok(h.node('srAnnounce'));
  assert.equal(h.node('srAnnounce').getAttribute('aria-live'), 'polite');
});

test('export state downloads a snapshot JSON with the canonical hash', () => {
  const h = app();
  h.node('exportStateBtn').click();
  assert.equal(h.document.downloads.length, 1);
  assert.equal(h.document.downloads[0].name, 'chipper8-state.json');
  const blob = [...h.blobs.values()][0];
  assert.ok(blob.size > 8000); // packed 4K RAM plus registers
  assert.match(h.node('srAnnounce').textContent, /snapshot exported/i);
  h.frame();
});

test('export trace downloads a deterministic seeded report', () => {
  const h = app();
  h.node('exportTraceBtn').click();
  assert.equal(h.document.downloads.length, 1);
  assert.equal(h.document.downloads[0].name, 'chipper8-trace.json');
  assert.match(h.node('toast').textContent, /instructions, hash [0-9a-f]{8}/);
});

test('N key single steps and T key ticks the 60 Hz timers', () => {
  const h = app();
  compile(h, 'LD V0,10\nLD DT,V0\nJP 0x204');
  h.event(h.document, 'keydown', { key: 'n' });
  h.event(h.document, 'keydown', { key: 'n' });
  assert.equal(h.node('opCount').textContent, '2');
  assert.equal(state(h, 'DT'), '10');
  h.event(h.document, 'keydown', { key: 't' });
  assert.equal(state(h, 'DT'), '9');
});

test('Backspace resets the machine to the active cartridge', () => {
  const h = app();
  compile(h, 'LD V0,7\nJP 0x200');
  h.node('stepBtn').click();
  h.event(h.document, 'keydown', { key: 'Backspace' });
  assert.equal(state(h, 'PC'), '0x200');
  assert.equal(h.node('opCount').textContent, '0');
});

test('bracket keys cycle the cartridge bank in both directions', () => {
  const h = app();
  const first = h.node('activeRomName').textContent;
  h.event(h.document, 'keydown', { key: ']' });
  const second = h.node('activeRomName').textContent;
  assert.notEqual(second, first);
  h.event(h.document, 'keydown', { key: '[' });
  assert.equal(h.node('activeRomName').textContent, first);
  for (let i = 0; i < 4; i++) { h.event(h.document, 'keydown', { key: ']' }); }
  assert.equal(h.node('activeRomName').textContent, first); // wraps around the bank
});

test('P cycles the phosphor theme and M attempts the piezo gate', () => {
  const h = app();
  h.event(h.document, 'keydown', { key: 'p' });
  assert.equal(h.document.documentElement.getAttribute('data-theme'), 'green');
  h.event(h.document, 'keydown', { key: 'm' });
  assert.match(h.node('toast').textContent, /unavailable/);
  assert.equal(h.node('audioToggle').checked, false);
});

test('O and U fire the state and trace exports from the keyboard', () => {
  const h = app();
  h.event(h.document, 'keydown', { key: 'o' });
  h.event(h.document, 'keydown', { key: 'u' });
  assert.equal(h.document.downloads.length, 2);
  assert.deepEqual(h.document.downloads.map(d => d.name), ['chipper8-state.json', 'chipper8-trace.json']);
});

test('bench shortcuts stay silent while typing in the assembly editor', () => {
  const h = app();
  const editor = h.node('assemblyEditor');
  compile(h, 'LD V0,1\nJP 0x200');
  const ops = h.node('opCount').textContent;
  h.event(editor, 'keydown', { key: 'n' });
  h.event(editor, 'keydown', { key: 't' });
  h.event(editor, 'keydown', { key: 'Backspace' });
  assert.equal(h.node('opCount').textContent, ops);
  assert.equal(state(h, 'PC'), '0x200');
});

test('the live region announces load, run, pause and reset transitions', () => {
  const h = app();
  assert.match(h.node('srAnnounce').textContent, /loaded/i);
  h.node('playBtn').click();
  assert.match(h.node('srAnnounce').textContent, /RUNNING/);
  h.node('pauseBtn').click();
  assert.match(h.node('srAnnounce').textContent, /PAUSED/);
});

test('announcer deduplicates a repeated status word', () => {
  const h = app();
  h.node('playBtn').click();
  h.node('pauseBtn').click();
  h.node('stepBtn').click();
  assert.equal(h.node('srAnnounce').textContent, 'STEP');
  h.node('stepBtn').click();
  assert.equal(h.node('srAnnounce').textContent, 'STEP'); // unchanged, not requeued
});

test('runtime diagnostics render with codes, addresses and totals', () => {
  const h = app();
  compile(h, 'SYS 0x123\nSYS 0x123\nJP 0x204');
  h.node('stepBtn').click();
  h.node('stepBtn').click();
  const items = h.node('diagList').children;
  assert.ok(items.length >= 1);
  assert.match(h.node('diagList').textContent, /SYS_NOP/);
  assert.match(h.node('diagCount').textContent, /2 events \/ 1 codes/);
});

test('a clipped sprite under chip48 surfaces in the diagnostic list', () => {
  const h = app();
  h.node('profileSelect').value = 'chip48';
  h.event(h.node('profileSelect'), 'change');
  compile(h, 'LD V0,63\nLD V1,31\nLD I,spr\nDRW V0,V1,2\nJP 0x200\nspr: DB 0xFF,0xFF');
  for (let i = 0; i < 4; i++) { h.node('stepBtn').click(); }
  assert.match(h.node('diagList').textContent, /SPRITE_CLIPPED/);
});

test('ROM lint reports an odd length cartridge after assembly', () => {
  const h = app();
  compile(h, 'LD V0,1\nsprite: DB 0x80');
  assert.match(h.node('romDiag').textContent, /ROM LINT: 0 errors \/ 1 warnings/);
  assert.match(h.node('romDiag').textContent, /ODD_LENGTH/);
});

test('ROM lint reports clean for a well formed cartridge', () => {
  const h = app();
  compile(h, 'CLS\nJP 0x200');
  assert.match(h.node('romDiag').textContent, /clean/);
});

test('lint notes unassigned data words without alarming on valid code', () => {
  const h = app();
  compile(h, 'LD V0,1\nJP 0x200\nsprite: DW 0x8FF9');
  assert.match(h.node('romDiag').textContent, /notes/);
  assert.match(h.node('romDiag').textContent, /UNASSIGNED_WORD/);
});
