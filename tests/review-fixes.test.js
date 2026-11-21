'use strict';
// Regression coverage for the six release-review findings: atomic snapshot
// restore with a mandatory hash, the persisted RNG cursor, the full-state
// per-step trace hash, deterministic 60 Hz trace timers, quirk-aware BNNN
// reporting, and the persistent keyboard-shortcut switch.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Chip8 = require('../engine.js');
const { boot } = require('./dom-harness.cjs');
const repo = path.join(__dirname, '..');
const scripts = ['engine.js', 'assembler.js', 'roms.js', 'clock.js', 'app.js'];
function app(options) { return boot(repo, scripts, options); }
function compile(h, source) { h.node('assemblyEditor').value = source; h.node('assembleBtn').click(); }
function state(h, key) { return h.node('stateGrid').children.find(n => n.textContent.startsWith(key)).querySelector('.v').textContent; }

// 1. restoreState must validate a staged copy and the mandatory stateHash
//    before committing anything to the receiver.
test('a rejected restore leaves the receiving machine completely untouched', () => {
  const a = new Chip8(); a.load([0x60, 1]);
  const b = new Chip8(); b.load([0x60, 2]); b.step();
  const before = a.exportState();
  assert.throws(() => a.restoreState({ ...b.snapshotState(), stateHash: '00000000' }), /hash mismatch/);
  assert.equal(a.exportState(), before);
  assert.equal(a.V[0], 0);    // CPU A never adopted B's V0=2
  assert.equal(a.pc, 0x200);  // or B's stepped program counter
});

test('a snapshot missing stateHash is rejected rather than silently accepted', () => {
  const b = new Chip8(); b.load([0x60, 2]); b.step();
  const snap = b.snapshotState();
  delete snap.stateHash;
  snap.v[0] = 123; // mutated field plus a deleted hash gate
  const receiver = new Chip8();
  const before = receiver.exportState();
  assert.throws(() => receiver.restoreState(snap), RangeError);
  assert.equal(receiver.exportState(), before);
});

test('non-string, malformed and wrong-algorithm snapshot hashes are rejected', () => {
  const b = new Chip8(); b.load([0x60, 2]); b.step();
  const s = b.snapshotState();
  for (const tamper of [
    { stateHash: 42 },
    { stateHash: null },
    { stateHash: 'not-hex' },
    { hashAlgorithm: 'sha-256' },
    { hashAlgorithm: undefined }
  ]) {
    const snap = Object.assign({}, s, tamper);
    assert.throws(() => new Chip8().restoreState(snap), RangeError, JSON.stringify(tamper));
  }
});

test('every failed restore path leaves the receiver state intact', () => {
  const b = new Chip8(); b.load([0x60, 2]); b.step();
  const s = b.snapshotState();
  const receiver = new Chip8(); receiver.load([0x6A, 0x77]); receiver.step();
  const before = receiver.exportState();
  for (const snap of [
    null, 'x', {}, { format: 'chipper8-snapshot', version: 1 },
    { ...s, memory: s.memory.slice(0, -2) },
    { ...s, quirks: { ...s.quirks, clipSprites: 1 } },
    { ...s, v: s.v.slice(0, 15) }
  ]) {
    assert.throws(() => receiver.restoreState(snap), RangeError, JSON.stringify(snap));
    assert.equal(receiver.exportState(), before);
  }
});

// 2. The built-in seeded RNG cursor rides in the snapshot and the hash so a
//    restored machine resumes the CXKK stream deterministically.
test('snapshot persists the seeded RNG cursor so RND resumes identically', () => {
  const rom = [0xC0, 0xFF, 0xC0, 0xFF];
  const a = new Chip8(); a.rng = Chip8.seededRng(200); a.load(rom);
  a.step(); // first RND consumed one draw from the stream
  const snap = a.snapshotState();
  assert.equal(snap.rngKind, 'mulberry32');
  assert.equal(snap.rngSeed, 200);
  assert.ok(Number.isInteger(snap.rngState));
  const b = new Chip8(); b.restoreState(snap);
  assert.equal(b.stateHash(), snap.stateHash);
  a.step(); b.step();
  assert.equal(a.V[0], 155); // stream position reproduced on the original
  assert.equal(b.V[0], 155); // and on the restored machine
  assert.equal(b.stateHash(), a.stateHash());
});

test('custom RNG functions are explicitly marked non-serializable', () => {
  const c = new Chip8(); c.load([0xC0, 0xFF]); c.rng = () => 0.5;
  const s = c.snapshotState();
  assert.equal(s.rngKind, 'custom-unserializable');
  assert.equal(s.rngState, null);
  const d = new Chip8(); d.restoreState(s);
  assert.equal(d.stateHash(), s.stateHash);
});

test('the RNG cursor participates in the canonical state hash', () => {
  const seeded = new Chip8(); seeded.rng = Chip8.seededRng(9); seeded.load([0x60, 1]);
  const custom = new Chip8(); custom.load([0x60, 1]); // Math.random
  assert.notEqual(seeded.stateHash(), custom.stateHash());
  const before = seeded.stateHash();
  seeded.rng.rngState = (seeded.rng.rngState + 1) >>> 0;
  assert.notEqual(seeded.stateHash(), before);
});

test('snapshots with missing or unknown RNG kinds are rejected', () => {
  const b = new Chip8(); b.load([0x60, 2]);
  const missing = b.snapshotState(); delete missing.rngKind;
  assert.throws(() => new Chip8().restoreState(missing), /rngKind/);
  const unknown = b.snapshotState(); unknown.rngKind = 'lcg-unknown';
  assert.throws(() => new Chip8().restoreState(unknown), /rng kind/);
});

// 3. The per-step trace hash covers full observable state, not just the
//    register file.
test('per-step trace hash diverges when a draw lands different pixels', () => {
  const a = new Chip8(); a.load([0xD0, 0x11]); a.I = 0x300; a.memory[0x300] = 0x80;
  const b = new Chip8(); b.load([0xD0, 0x11]); b.I = 0x300; b.memory[0x300] = 0x40;
  assert.notEqual(a.trace(1).entries[0].h, b.trace(1).entries[0].h);
});

test('per-step trace hash equals the canonical state hash after each step', () => {
  const rom = [0x60, 0x05, 0x61, 0x07, 0x80, 0x14];
  const c = new Chip8(); c.load(rom);
  const r = c.trace(3);
  const d = new Chip8(); d.load(rom);
  d.step(); assert.equal(r.entries[0].h, d.stateHash());
  d.step(); assert.equal(r.entries[1].h, d.stateHash());
  d.step(); assert.equal(r.entries[2].h, d.stateHash());
  assert.equal(r.entries[2].h, r.finalHash);
});

test('per-step trace hash diverges on RAM edits that never touch registers', () => {
  const rom = [0xF1, 0x33]; // LD B, V1 writes RAM at I
  const a = new Chip8(); a.load(rom); a.I = 0x300; a.V[1] = 7;
  const b = new Chip8(); b.load(rom); b.I = 0x300; b.V[1] = 8;
  assert.notEqual(a.trace(1).entries[0].h, b.trace(1).entries[0].h);
});

// 4. Timed traces tick the 60 Hz timers on an explicit recorded schedule.
test('timed trace advances 60 Hz timers and reaches the guarded block', () => {
  const rom = [0x60, 0x01, 0xF0, 0x15, 0xF0, 0x07, 0x30, 0x00, 0x12, 0x04, 0x61, 0x01, 0x12, 0x0C];
  const r = Chip8.traceProgram(rom, 600);
  assert.equal(r.timerSchedule.mode, 'timed');
  assert.equal(r.timerSchedule.cyclesPerTick, 12);
  assert.equal(r.timerSchedule.cpuHz, 720);
  assert.ok(r.entries.some(e => e.pc === 0x20A)); // LD V1, 1 executes
  const f007 = r.entries.filter(e => e.op === 0xF007);
  assert.ok(f007.some(e => e.dt === 0));          // the wait loop saw DT reach 0
  assert.equal(r.meta.timers, 'timed');
});

test('frozen mode keeps timers static and labels the export explicitly', () => {
  const rom = [0x60, 0x01, 0xF0, 0x15, 0xF0, 0x07, 0x30, 0x00, 0x12, 0x04, 0x61, 0x01, 0x12, 0x0C];
  const r = Chip8.traceProgram(rom, 600, { timers: 'frozen' });
  assert.equal(r.timerSchedule.mode, 'frozen');
  assert.equal(r.timerSchedule.cyclesPerTick, null);
  assert.equal(r.timerSchedule.cpuHz, null);
  assert.ok(!r.entries.some(e => e.pc === 0x20A));
  assert.ok(r.entries.slice(1).every(e => e.dt === 1)); // DT set once, never ticks
});

test('cyclesPerTick controls the deterministic tick cadence', () => {
  const c = new Chip8(); c.load([0x00, 0xE0]);
  c.delayTimer = 4;
  const r = c.trace(20, { cyclesPerTick: 5 });
  assert.equal(r.timerSchedule.cpuHz, 300);
  assert.equal(r.entries[9].dt, 3);   // tick after instructions 5 and 10
  assert.equal(r.entries[10].dt, 2);
  assert.equal(r.entries[19].dt, 1);
  assert.equal(c.delayTimer, 0);      // 4 ticks over 20 instructions
});

test('trace validates the timer schedule options', () => {
  const c = new Chip8(); c.load([0x60, 0x01]);
  assert.throws(() => c.trace(2, { timers: 'sometimes' }), RangeError);
  assert.throws(() => c.trace(2, { cyclesPerTick: 0 }), RangeError);
  assert.throws(() => c.trace(2, { cyclesPerTick: 1.5 }), RangeError);
});

// 5. Under jumpUsesVx (CHIP-48) live and exported traces report the
//    effective register and the resolved jump target.
test('chip48 offset jump reports V2 and the resolved 0x23F target', () => {
  const c = new Chip8(); c.load([0x62, 0x0B, 0xB2, 0x34]); c.setProfile('chip48');
  const r = c.trace(2);
  assert.equal(r.entries[1].mnemonic, 'JP V2, 0x234 -> 0x23F');
  assert.equal(r.entries[1].target, 0x23F);
  assert.equal(c.pc, 0x23F);
});

test('vip offset jump reports V0 and its resolved target', () => {
  const c = new Chip8(); c.setProfile('vip'); c.load([0xB3, 0x00]); c.V[0] = 0x10;
  const r = c.trace(1);
  assert.equal(r.entries[0].mnemonic, 'JP V0, 0x300 -> 0x310');
  assert.equal(r.entries[0].target, 0x310);
  assert.equal(c.pc, 0x310);
});

test('neutral disassemble stays round-trippable while traces are quirk-aware', () => {
  const c = new Chip8(); c.setProfile('chip48'); c.load([0x62, 0x0B, 0xB2, 0x34]);
  assert.equal(c.disassemble(0xB234), 'JP V0, 0x234'); // assembler spelling
  c.step();
  assert.equal(c.disassembleEffective(0xB234), 'JP V2, 0x234 -> 0x23F');
});

test('the live bus trace shows the effective chip48 jump mnemonic', () => {
  const h = app();
  h.node('profileSelect').value = 'chip48';
  h.event(h.node('profileSelect'), 'change');
  compile(h, 'LD V2,0x0B\nJP V0,0x234');
  h.node('stepBtn').click();
  h.node('stepBtn').click();
  assert.match(h.node('busTraceBody').children[0].textContent, /JP V2, 0x234 -> 0x23F/);
});

// 6. SW6 is a persistent off switch for every global character-key shortcut.
test('SW6 disables every global character-key shortcut and hex input', () => {
  const h = app();
  const toggle = h.node('shortcutsToggle');
  assert.equal(toggle.checked, true); // ships enabled
  toggle.checked = false;
  h.event(toggle, 'change');
  assert.equal(h.node('shortcutsLabel').textContent, 'KEY BENCH OFF');
  assert.equal(h.sandbox.localStorage.getItem('chipper8-shortcuts'), 'off');

  compile(h, 'LD V0,7\nJP 0x200');
  for (const key of ['n', 't', 'o', 'u', 'm', 'p', '[', ']']) {
    h.event(h.document, 'keydown', { key });
  }
  assert.equal(h.node('opCount').textContent, '0');             // no steps/ticks
  assert.equal(h.document.downloads.length, 0);                 // no O/U exports
  assert.equal(h.document.documentElement.getAttribute('data-theme'), 'amber'); // no P cycle
  h.event(h.document, 'keydown', { key: ' ', repeat: false });
  assert.equal(h.node('playBtn').disabled, false);              // no Space run
  h.event(h.document, 'keydown', { key: 'w' });
  const key5 = h.node('keypad').children.find(b => b.dataset.value === '5');
  assert.equal(key5.getAttribute('aria-pressed'), 'false');     // no hex input
});

test('the shortcut-off preference persists across boots', () => {
  const h = app({ storage: { 'chipper8-shortcuts': 'off' } });
  assert.equal(h.node('shortcutsToggle').checked, false);
  h.event(h.document, 'keydown', { key: 'n' });
  assert.equal(h.node('opCount').textContent, '0');
});

test('Backspace reset and pointer controls keep working with shortcuts off', () => {
  const h = app({ storage: { 'chipper8-shortcuts': 'off' } });
  compile(h, 'LD V0,7\nJP 0x200');
  h.node('stepBtn').click();
  assert.equal(h.node('opCount').textContent, '1');
  h.event(h.document, 'keydown', { key: 'Backspace' }); // non-printable stays
  assert.equal(h.node('opCount').textContent, '0');
  assert.equal(state(h, 'PC'), '0x200');
});

test('turning SW6 back on restores the bench keys', () => {
  const h = app();
  const toggle = h.node('shortcutsToggle');
  toggle.checked = false; h.event(toggle, 'change');
  h.event(h.document, 'keydown', { key: 'n' });
  assert.equal(h.node('opCount').textContent, '0');
  toggle.checked = true; h.event(toggle, 'change');
  assert.equal(h.sandbox.localStorage.getItem('chipper8-shortcuts'), 'on');
  h.event(h.document, 'keydown', { key: 'n' });
  assert.equal(h.node('opCount').textContent, '1');
});

test('disabling shortcuts releases a held hex key instead of leaving it stuck', () => {
  const h = app();
  const key5 = h.node('keypad').children.find(b => b.dataset.value === '5');
  h.event(h.document, 'keydown', { key: 'w' });
  assert.equal(key5.getAttribute('aria-pressed'), 'true');
  const toggle = h.node('shortcutsToggle');
  toggle.checked = false; h.event(toggle, 'change');
  assert.equal(key5.getAttribute('aria-pressed'), 'false');
  h.event(h.document, 'keyup', { key: 'w' }); // late keyup is a safe no-op
  assert.equal(key5.getAttribute('aria-pressed'), 'false');
});
