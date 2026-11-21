'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot } = require('./dom-harness.cjs');
const repo = path.join(__dirname, '..');
const scripts = ['engine.js', 'assembler.js', 'roms.js', 'clock.js', 'app.js'];
function app(options) { return boot(repo, scripts, options); }
function compile(h, source) { h.node('assemblyEditor').value = source; h.node('assembleBtn').click(); }
function state(h, key) { return h.node('stateGrid').children.find(n => n.textContent.startsWith(key)).querySelector('.v').textContent; }

test('the shipped HTML boots every browser script and builds all live controls', () => {
  const h = app(); assert.equal(h.errors.length, 0); assert.equal(h.node('romList').children.length, 4);
  assert.equal(h.node('keypad').children.length, 16); assert.equal(h.node('regGrid').children.length, 16);
  assert.equal(h.node('verificationBadge').textContent, '35 instruction round trips passed'); assert.equal(state(h, 'PC'), '0x200');
});
test('every literal DOM binding in app.js resolves to an element in the actual HTML', () => {
  const h = app(), source = fs.readFileSync(path.join(repo, 'app.js'), 'utf8');
  for (const [, id] of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(h.node(id), id);
});
test('single stepping executes exactly one instruction and leaves 60 Hz timers unchanged', () => {
  const h = app(); compile(h, 'LD V0,10\nLD DT,V0\nJP 0x204');
  h.node('stepBtn').click(); h.node('stepBtn').click(); assert.equal(state(h, 'DT'), '10');
  h.node('stepBtn').click(); assert.equal(state(h, 'DT'), '10'); assert.equal(h.node('opCount').textContent, '3');
  h.node('timerStepBtn').click(); assert.equal(state(h, 'DT'), '9');
});
test('reset restores the active custom ROM at 0x200 without hidden instructions', () => {
  const h = app(); compile(h, 'LD V0,7\nJP 0x200'); h.node('stepBtn').click(); h.node('resetBtn').click();
  assert.equal(state(h, 'PC'), '0x200'); assert.equal(h.node('opCount').textContent, '0'); assert.match(h.node('activeRomName').textContent, /CUSTOM ROM/);
});
test('play and pause deliver an independent 60 Hz timer clock', () => {
  const h = app(); compile(h, 'LD V0,120\nLD DT,V0\nJP 0x204'); h.node('stepBtn').click(); h.node('stepBtn').click();
  h.node('playBtn').click(); for (let i = 0; i < 60; i++) h.frame(); assert.equal(state(h, 'DT'), '60');
  h.node('pauseBtn').click(); const count = h.node('opCount').textContent; h.frame(500); assert.equal(h.node('opCount').textContent, count);
});
test('Space repeats do not toggle playback and native button Space stays local', () => {
  const h = app(); h.event(h.document, 'keydown', { key: ' ', repeat: false }); assert.equal(h.node('playBtn').disabled, true);
  h.event(h.document, 'keydown', { key: ' ', repeat: true }); assert.equal(h.node('playBtn').disabled, true);
  h.node('pauseBtn').click(); h.event(h.node('resetBtn'), 'keydown', { key: ' ', repeat: false }); assert.equal(h.node('playBtn').disabled, false);
});
test('all hexadecimal keypad buttons support Enter and Space with pressed states', () => {
  const h = app(); for (const button of h.node('keypad').children) {
    assert.equal(button.tagName, 'BUTTON'); assert.equal(button.getAttribute('tabindex'), '0');
    h.event(button, 'keydown', { key: 'Enter' }); assert.equal(button.getAttribute('aria-pressed'), 'true');
    h.event(button, 'keyup', { key: 'Enter' }); assert.equal(button.getAttribute('aria-pressed'), 'false');
  }
});
test('releasing a pointer does not release a key still held on the physical keyboard', () => {
  const h = app(); const button = h.node('keypad').children.find(b => b.dataset.value === '5');
  h.event(h.document, 'keydown', { key: 'w' }); h.event(button, 'pointerdown', { pointerId: 1 }); h.event(button, 'pointerup', { pointerId: 1 });
  assert.equal(button.getAttribute('aria-pressed'), 'true'); h.event(h.document, 'keyup', { key: 'w' }); assert.equal(button.getAttribute('aria-pressed'), 'false');
});
test('blur and a hidden document pause execution and release every input', () => {
  const h = app(); h.node('playBtn').click(); h.event(h.document, 'keydown', { key: 'w' }); h.event(h.windowEvents, 'blur');
  assert.equal(h.node('playBtn').disabled, false); assert.ok(h.node('keypad').children.every(b => b.getAttribute('aria-pressed') === 'false'));
  h.node('playBtn').click(); h.document.hidden = true; h.event(h.document, 'visibilitychange'); assert.equal(h.rafs.size, 0);
});
test('one click XOR showcase demonstrates erase collision within one second', () => {
  const h = app(); h.node('showcaseXor').click(); let scored = false;
  for (let i = 0; i < 60; i++) { h.frame(); scored ||= h.node('scoreValue').textContent === '1'; }
  assert.equal(scored, true); assert.match(h.node('activeRomName').textContent, /XOR COLLISION LAB/); assert.match(h.node('quirkComparison').textContent, /V7 = 1/);
});
test('interpreter comparison calculates the divergent result from three actual CPUs', () => {
  const h = app(); h.node('showcaseQuirks').click(); assert.match(h.node('quirkComparison').textContent, /MODERN: V1=4, VF=1/);
  assert.match(h.node('quirkComparison').textContent, /VIP: V1=3, VF=0/); assert.match(h.node('quirkComparison').textContent, /CHIP48: V1=4, VF=1/);
});
test('profile changes pause playback and update the physical switches', () => {
  const h = app(); h.node('playBtn').click(); h.node('profileSelect').value = 'vip'; h.event(h.node('profileSelect'), 'change');
  assert.equal(h.node('playBtn').disabled, false); assert.equal(h.node('quirkShiftVy').checked, true); assert.equal(h.node('quirkLoadStore').checked, false);
  assert.match(h.node('quirkComparison').textContent, /key release/);
  assert.match(h.node('quirkProfileLine').textContent, /sprites clip \/ logic clears VF \/ key release completes FX0A/);
  h.node('profileSelect').value = 'modern'; h.event(h.node('profileSelect'), 'change');
  assert.match(h.node('quirkProfileLine').textContent, /sprites wrap \/ logic retains VF \/ held key completes FX0A/);
});
test('assembler errors include line numbers and preserve the loaded cartridge', () => {
  const h = app(), name = h.node('activeRomName').textContent; compile(h, 'CLS\nLD VX,1');
  assert.match(h.node('assemblerStatus').textContent, /Line 2/); assert.equal(h.node('activeRomName').textContent, name);
});
test('a breakpoint stops before execution and resumes through exactly one matching address', () => {
  const h = app(); compile(h, 'LD V0,1\nLD V1,2\nJP 0x200'); h.node('breakpointInput').value = '0x204'; h.node('breakpointBtn').click();
  h.node('playBtn').click(); h.frame(100); assert.equal(state(h, 'PC'), '0x204'); assert.equal(h.node('opCount').textContent, '2');
  h.node('playBtn').click(); h.frame(100); assert.equal(h.node('opCount').textContent, '5'); assert.equal(h.node('playBtn').disabled, false);
});
test('bad breakpoints show a clear error and an empty field removes the breakpoint', () => {
  const h = app(); h.node('breakpointInput').value = 'FFFF'; h.node('breakpointBtn').click(); assert.match(h.node('breakpointStatus').textContent, /000 to FFE/);
  h.node('breakpointInput').value = ''; h.node('breakpointBtn').click(); assert.equal(h.node('breakpointStatus').textContent, 'No breakpoint');
});
test('canvas backing pixels follow device scale while pointer inspection uses CSS coordinates', () => {
  const h = app({ dpr: 2 }), screen = h.node('screen'); assert.equal(screen.width, 1280); assert.equal(screen.height, 640);
  screen._rect = { width: 320, height: 160, left: 20, top: 10 }; h.event(h.windowEvents, 'resize');
  assert.equal(screen.width, 640); assert.equal(screen.height, 320); assert.equal(screen.context.imageSmoothingEnabled, false);
  h.event(screen, 'pointermove', { clientX: 180, clientY: 90 }); assert.match(h.node('pixelReadout').textContent, /\[32, 16\]/);
  h.event(screen, 'keydown', { key: 'ArrowRight' }); assert.match(h.node('pixelReadout').textContent, /\[33, 16\]/);
});
test('audio begins muted, reports unavailable audio and does not create autoplay sound', () => {
  const h = app(); assert.equal(h.node('audioToggle').checked, false); h.node('audioToggle').checked = true; h.event(h.node('audioToggle'), 'change');
  assert.equal(h.node('audioToggle').checked, false); assert.match(h.node('toast').textContent, /unavailable/);
});
test('ROM export contains the actual custom bytes and releases its object URL', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200'); h.node('downloadRomBtn').click();
  assert.equal(h.document.downloads.length, 1); assert.equal([...h.blobs.values()][0].size, 4); h.frame(); assert.equal(h.blobs.size, 0);
});
test('all themes work when browser storage is blocked', () => {
  const h = app({ blockStorage: true }); h.node('themeToggle').click(); assert.equal(h.document.documentElement.getAttribute('data-theme'), 'green');
  h.node('themeToggle').click(); assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light'); assert.equal(h.errors.length, 0);
});
test('empty comment-only assembly rejects cleanly without wiping CPU registers or active cartridge', () => {
  const h = app(); compile(h, 'LD V0, 7\nJP 0x200'); h.node('stepBtn').click();
  const nameBefore = h.node('activeRomName').textContent;
  assert.equal(h.node('regGrid').children[0].querySelector('.rv').textContent, '07');
  compile(h, '; just a comment\n');
  assert.match(h.node('assemblerStatus').textContent, /0 bytes/);
  assert.equal(h.node('regGrid').children[0].querySelector('.rv').textContent, '07');
  assert.equal(h.node('activeRomName').textContent, nameBefore);
});
test('releasing Enter or blur on a virtual key preserves a held physical key', () => {
  const h = app(); const button = h.node('keypad').children.find(b => b.dataset.value === '5');
  h.event(h.document, 'keydown', { key: 'w' });
  h.event(button, 'keydown', { key: 'Enter' });
  h.event(button, 'keyup', { key: 'Enter' });
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  h.event(button, 'blur');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  h.event(h.document, 'keyup', { key: 'w' });
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});
test('pixel inspection readout refreshes immediately after CLS clears drawn pixels', () => {
  const h = app(), screen = h.node('screen');
  screen._rect = { width: 320, height: 160, left: 0, top: 0 };
  compile(h, 'LD V0,0\nLD V1,0\nLD I,dot\nDRW V0,V1,1\nCLS\nJP 0x200\ndot: DB 0x80');
  for (let i = 0; i < 4; i++) h.node('stepBtn').click();
  h.event(screen, 'pointermove', { clientX: 1, clientY: 1 });
  assert.match(h.node('pixelReadout').textContent, /PIXEL \[0, 0\] = 1/);
  h.node('stepBtn').click();
  assert.match(h.node('pixelReadout').textContent, /PIXEL \[0, 0\] = 0/);
});
test('physical game keys still work when a ROM or UI button is focused', () => {
  const h = app();
  const romBtn = h.node('romList').children[0];
  romBtn.click();
  h.event(romBtn, 'keydown', { key: '2', repeat: false });
  const key2 = h.node('keypad').children.find(b => b.dataset.value === '2');
  assert.equal(key2.getAttribute('aria-pressed'), 'true');
  h.event(h.document, 'keyup', { key: '2' });
  assert.equal(key2.getAttribute('aria-pressed'), 'false');
});
test('instruction trace keeps sixteen rows and the RAM window follows the PC', () => {
  const h = app();
  compile(h, 'LD V0,1\nLD V1,2\nLD V2,3\nLD V3,4\nLD V4,5\nLD V5,6\nLD V6,7\nLD V7,8\nLD V8,9\nLD V9,10\nLD VA,11\nLD VB,12\nLD VC,13\nLD VD,14\nLD VE,15\nLD VF,16\nJP 0x200');
  for (let i = 0; i < 17; i++) h.node('stepBtn').click();
  assert.equal(h.node('busTraceBody').children.length, 16);
  // After stepping back to 0x200 the window starts eight bytes earlier.
  assert.match(h.node('ramWindow').textContent, /0x1F8:/);
  assert.match(h.node('ramWindow').textContent, /0x200:/);
});
test('hero has no all-caps eyebrow or helper line under the title', () => {
  const h = app();
  const intro = h.document.querySelector('.workbench-intro');
  assert.ok(intro);
  assert.equal(intro.querySelector('.eyebrow'), null);
  const heading = intro.querySelectorAll('h2')[0];
  assert.equal(heading.textContent, 'See every bit of the machine.');
});
