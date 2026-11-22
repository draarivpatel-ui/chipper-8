'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { boot } = require('./dom-harness.cjs');
const repo = path.join(__dirname, '..');
const scripts = ['engine.js', 'assembler.js', 'roms.js', 'clock.js', 'sha256.js', 'studio.js', 'app.js'];
function app(options) { return boot(repo, scripts, options); }
function compile(h, source) { h.node('assemblyEditor').value = source; h.node('assembleBtn').click(); }
function state(h, key) { return h.node('stateGrid').children.find(n => n.textContent.startsWith(key)).querySelector('.v').textContent; }

test('the studio panel boots with matrix, coverage svg and all audit controls', () => {
  const h = app(); assert.equal(h.errors.length, 0);
  assert.ok(h.node('stepBackBtn')); assert.ok(h.node('timeDepth'));
  assert.ok(h.node('quirkMatrixBody')); assert.ok(h.node('quirkLive'));
  assert.ok(h.node('coverageSvg')); assert.ok(h.node('coverageTotal')); assert.ok(h.node('coverageNote'));
  assert.ok(h.node('auditJsonBtn')); assert.ok(h.node('auditCsvBtn')); assert.ok(h.node('auditMdBtn'));
  assert.ok(h.node('auditVerifyBtn')); assert.ok(h.node('auditStatus'));
  assert.ok(h.node('selfTestBtn')); assert.ok(h.node('selfTestSummary')); assert.ok(h.node('selfTestList'));
});

test('quirk matrix renders six quirk rows across three profiles plus the live column', () => {
  const h = app();
  const rows = h.node('quirkMatrixBody').children;
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.equal(row.children.length, 5); // label + vip + chip48 + modern + live
    assert.equal(row.children[0].tagName, 'TH');
  }
  assert.equal(rows[0].children[1].getAttribute('class'), 'qk-on');
  assert.match(h.node('quirkLive').textContent, /DIVERGES/);
});

test('live quirk column follows the profile switcher', () => {
  const h = app();
  h.node('profileSelect').value = 'vip'; h.event(h.node('profileSelect'), 'change');
  const find = key => h.node('quirkMatrixBody').children.find(r => r.children[0].textContent.includes(key));
  assert.equal(find('SHIFTS').children[4].getAttribute('class'), 'qk-live-on');
  assert.equal(find('CLIPS').children[4].getAttribute('class'), 'qk-live-on');
  assert.equal(find('STATIC I').children[4].getAttribute('class'), 'qk-live-off'); // VIP increments I
  h.node('profileSelect').value = 'chip48'; h.event(h.node('profileSelect'), 'change');
  assert.equal(find('STATIC I').children[4].getAttribute('class'), 'qk-live-on');  // CHIP-48 freezes I
  h.node('profileSelect').value = 'modern'; h.event(h.node('profileSelect'), 'change');
  assert.equal(find('SHIFTS').children[4].getAttribute('class'), 'qk-live-off');
});

test('coverage svg fills sixteen family cells and counts live execution', () => {
  const h = app(); compile(h, 'LD V0,1\nLD V1,2\nJP 0x200');
  for (let i = 0; i < 3; i++) h.node('stepBtn').click();
  const groups = h.node('coverageSvg').children;
  assert.equal(groups.length, 16);
  assert.equal(h.node('coverageTotal').textContent, '3');
  assert.match(h.node('coverageNote').textContent, /Hottest family 0x6/);
});

test('coverage histogram tracks the executed families', () => {
  const h = app(); compile(h, 'LD V0,1\nLD V1,2\nJP 0x200');
  for (let i = 0; i < 5; i++) h.node('stepBtn').click();
  // LD, LD, JP, LD, LD -> family 6 x4, family 1 x1
  const nums = h.node('coverageSvg').querySelectorAll('.cov-num').map(t => t.textContent);
  assert.equal(nums[6], '4'); assert.equal(nums[1], '1');
  assert.equal(h.node('coverageTotal').textContent, '5');
});

test('step-back button rewinds exactly one executed instruction', () => {
  const h = app(); compile(h, 'LD V0,7\nLD V1,9\nJP 0x200');
  for (let i = 0; i < 3; i++) h.node('stepBtn').click();
  assert.equal(h.node('opCount').textContent, '3');
  h.node('stepBackBtn').click();
  assert.equal(state(h, 'PC'), '0x204');
  assert.equal(h.node('opCount').textContent, '2');
  h.node('stepBackBtn').click();
  assert.equal(state(h, 'PC'), '0x202');
  assert.equal(h.node('opCount').textContent, '1');
});

test('step-back restores register values to the prior state', () => {
  const h = app(); compile(h, 'LD V0,7\nLD V1,9\nJP 0x200');
  for (let i = 0; i < 3; i++) h.node('stepBtn').click();
  h.node('stepBackBtn').click(); h.node('stepBackBtn').click();
  const v1 = h.node('regGrid').children[1].querySelector('.rv');
  assert.equal(v1.textContent, '00');
});

test('step-back rewinds the coverage histogram too', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('stepBtn').click(); h.node('stepBtn').click();
  assert.equal(h.node('coverageTotal').textContent, '2');
  h.node('stepBackBtn').click();
  assert.equal(h.node('coverageTotal').textContent, '1');
});

test('the b key rewinds one instruction', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('stepBtn').click(); h.node('stepBtn').click();
  h.event(h.document, 'keydown', { key: 'b' });
  assert.equal(h.node('opCount').textContent, '1');
});

test('time depth readout reports captured snapshots', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('stepBtn').click(); h.node('stepBtn').click();
  assert.match(h.node('timeDepth').textContent, /2 \/ 256 captured/);
  h.node('stepBackBtn').click();
  assert.match(h.node('timeDepth').textContent, /1 \/ 256 captured/);
});

test('step-back on an empty ring shows a toast without breaking state', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('stepBackBtn').click();
  assert.match(h.node('toast').textContent, /Nothing to rewind/);
  assert.equal(state(h, 'PC'), '0x200');
});

test('reset clears the ring buffer and coverage', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('stepBtn').click(); h.node('stepBtn').click();
  h.node('resetBtn').click();
  assert.match(h.node('timeDepth').textContent, /0 \/ 256 captured/);
  assert.equal(h.node('coverageTotal').textContent, '0');
});

test('multiple comma-separated breakpoints stop the run loop in order', () => {
  const h = app(); compile(h, 'LD V0,1\nLD V1,2\nLD V2,3\nLD V3,4\nJP 0x200');
  h.node('breakpointInput').value = '0x202, 0x206';
  h.node('breakpointBtn').click();
  assert.match(h.node('breakpointStatus').textContent, /0x202, 0x206/);
  h.node('playBtn').click();
  for (let i = 0; i < 30 && h.node('playBtn').disabled; i++) h.frame();
  assert.equal(state(h, 'PC'), '0x202');
  h.node('playBtn').click();
  for (let i = 0; i < 30 && h.node('playBtn').disabled; i++) h.frame();
  assert.equal(state(h, 'PC'), '0x206');
});

test('a space-separated breakpoint list parses the same as commas', () => {
  const h = app();
  h.node('breakpointInput').value = '0x200 0x210';
  h.node('breakpointBtn').click();
  assert.match(h.node('breakpointStatus').textContent, /0x200, 0x210/);
});

test('a bad entry anywhere in the breakpoint list is rejected', () => {
  const h = app();
  h.node('breakpointInput').value = '0x200, xyz';
  h.node('breakpointBtn').click();
  assert.match(h.node('breakpointStatus').textContent, /000 to FFE/);
  h.node('breakpointInput').value = 'fff';
  h.node('breakpointBtn').click();
  assert.match(h.node('breakpointStatus').textContent, /000 to FFE/);
});

test('clearing the breakpoint field removes all breakpoints', () => {
  const h = app();
  h.node('breakpointInput').value = '0x200';
  h.node('breakpointBtn').click();
  h.node('breakpointInput').value = '';
  h.node('breakpointBtn').click();
  assert.equal(h.node('breakpointStatus').textContent, 'No breakpoint');
});

test('self-test runner lists every named check with PASS badges', () => {
  const h = app();
  h.node('selfTestBtn').click();
  const rows = h.node('selfTestList').children;
  assert.ok(rows.length >= 16);
  for (const row of rows) {
    assert.equal(row.querySelector('.st-badge').textContent, 'PASS', row.textContent);
  }
  assert.match(h.node('selfTestSummary').textContent, new RegExp(rows.length + ' / ' + rows.length + ' PASS'));
});

test('audit JSON export captures the blob text with a valid digest', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('auditJsonBtn').click();
  const ex = h.sandbox.__c8LastExport;
  assert.equal(ex.filename, 'chipper8-audit.json');
  const report = JSON.parse(ex.text);
  assert.equal(report.format, 'chipper8-audit');
  assert.match(report.digest.value, /^[0-9a-f]{64}$/);
});

test('audit CSV export escapes spreadsheet formulas', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('auditCsvBtn').click();
  const ex = h.sandbox.__c8LastExport;
  assert.equal(ex.filename, 'chipper8-audit.csv');
  assert.equal(ex.mime, 'text/csv');
  assert.ok(ex.text.startsWith('chipper8-audit,1,sha256,'));
});

test('audit markdown export includes the honest digest label', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('auditMdBtn').click();
  const ex = h.sandbox.__c8LastExport;
  assert.match(ex.text, /Unkeyed SHA-256 tamper-detection digest/);
});

test('in-page audit verification reports pass checks and catches tampering', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('auditVerifyBtn').click();
  const lines = h.node('auditStatus').textContent.split('\n');
  assert.ok(lines.length >= 4);
  assert.ok(lines.every(l => l.startsWith('PASS ')), h.node('auditStatus').textContent);
  assert.ok(lines.some(l => /tamper detected/.test(l)));
});

test('audit status shows the full digest after a JSON export', () => {
  const h = app(); compile(h, 'LD V0,1\nJP 0x200');
  h.node('auditJsonBtn').click();
  assert.match(h.node('auditStatus').textContent, /^Digest [0-9a-f]{64}$/);
});

test('bookmark state encodes into #c8= on speed changes where a location exists', () => {
  const h = app();
  // Harness has no window.location: exercise the encoder directly via studio.
  const Studio = h.sandbox.Chipper8.Studio;
  const enc = Studio.encodeBookmark({ profile: 'vip', dips: 7, speed: 600, rom: 2 });
  const dec = Studio.decodeBookmark('#c8=' + enc);
  assert.equal(dec.profile, 'vip'); assert.equal(dec.dips, 7); assert.equal(dec.rom, 2);
});
