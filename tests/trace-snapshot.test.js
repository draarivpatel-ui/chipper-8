'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');
const { assemble } = require('../assembler.js');
const { list: roms } = require('../roms.js');

function machine(words, configure) {
  const bytes = [];
  for (const w of words) { bytes.push(w >> 8, w & 0xFF); }
  const c = new Chip8();
  c.load(bytes);
  if (configure) { configure(c); }
  return c;
}

test('seededRng produces identical sequences for the same seed', () => {
  const a = Chip8.seededRng(1234), b = Chip8.seededRng(1234);
  for (let i = 0; i < 64; i++) { assert.equal(a(), b()); }
});

test('seededRng produces different streams for different seeds', () => {
  const a = Chip8.seededRng(1), b = Chip8.seededRng(2);
  const same = [...Array(32)].every((_, i) => i % 2 === 0 ? a() === b() : true);
  assert.equal(same, false);
});

test('seededRng output stays inside [0, 1)', () => {
  const rng = Chip8.seededRng(0);
  for (let i = 0; i < 512; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `value ${v} at index ${i}`);
  }
});

test('seededRng rejects non-integer and out-of-range seeds', () => {
  for (const seed of [-1, 1.5, NaN, 2 ** 32, '7', null]) {
    assert.throws(() => Chip8.seededRng(seed), RangeError, String(seed));
  }
});

test('stateHash is an 8 digit hex string stable across repeated calls', () => {
  const c = machine([0x6001]);
  const h = c.stateHash();
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(c.stateHash(), h);
});

test('stateHash changes when a general register changes', () => {
  const c = machine([0x6001]);
  const before = c.stateHash();
  c.V[3] = 0x77;
  assert.notEqual(c.stateHash(), before);
});

test('stateHash changes when the program counter moves', () => {
  const c = machine([0x6001]);
  const before = c.stateHash();
  c.pc = 0x204;
  assert.notEqual(c.stateHash(), before);
});

test('stateHash changes when a single display bit flips', () => {
  const c = machine([0x6001]);
  const before = c.stateHash();
  c.display[2047] = 1;
  assert.notEqual(c.stateHash(), before);
});

test('stateHash changes when a quirk flag toggles', () => {
  const c = machine([0x6001]);
  const before = c.stateHash();
  c.quirks.clipSprites = true;
  assert.notEqual(c.stateHash(), before);
});

test('stateHash changes when a RAM byte deep in memory changes', () => {
  const c = machine([0x6001]);
  const before = c.stateHash();
  c.memory[0x800] = 0xAB;
  assert.notEqual(c.stateHash(), before);
});

test('two machines running the same seeded program share one canonical hash', () => {
  const rom = [0xC0, 0xFF, 0xC1, 0xFF, 0x12, 0x00];
  const run = () => {
    const c = new Chip8();
    c.rng = Chip8.seededRng(99);
    c.load(rom);
    for (let i = 0; i < 40; i++) { c.step(); }
    return c.stateHash();
  };
  assert.equal(run(), run());
});

test('snapshotState exposes the canonical fields and formats', () => {
  const c = machine([0x6001, 0x1200]);
  c.step();
  const s = c.snapshotState();
  assert.equal(s.format, 'chipper8-snapshot');
  assert.equal(s.version, 2);
  assert.equal(s.hashAlgorithm, 'fnv1a-32');
  assert.equal(s.stateHash, c.stateHash());
  assert.equal(s.v.length, 16);
  assert.equal(s.stack.length, 16);
  assert.equal(s.keys.length, 16);
  assert.equal(s.memory.length, 8192);
  assert.equal(s.vram.length, 512);
  assert.equal(s.pc, 0x202);
  assert.equal(s.v[0], 1);
});

test('snapshot memory hex stores every RAM byte MSB first', () => {
  const c = machine([0xBEEF]);
  const s = c.snapshotState();
  assert.equal(s.memory.slice(0, 2), 'f0');           // font sprite byte
  assert.equal(s.memory.slice(0x400, 0x404), 'beef'); // program bytes at 0x200
});

test('snapshot vram packs eight pixels per byte MSB first', () => {
  const c = machine([0x6001]);
  c.display[0] = 1;
  c.display[7] = 1;
  c.display[8] = 1;
  const s = c.snapshotState();
  assert.equal(s.vram.slice(0, 4), '8180'); // 10000001 10000000
});

test('snapshot quirks mirror the active interpreter flags', () => {
  const c = machine([0x6001], (x) => x.setProfile('vip'));
  const s = c.snapshotState();
  assert.equal(s.quirks.shiftUsesVy, true);
  assert.equal(s.quirks.logicResetsVf, true);
  assert.equal(s.quirks.jumpUsesVx, false);
});

test('snapshot records pending key wait state', () => {
  const c = machine([0xF10A], (x) => x.setProfile('vip'));
  c.step();
  const s = c.snapshotState();
  assert.equal(s.waitingForKey, 1);
  const d = new Chip8();
  d.restoreState(s);
  assert.equal(d.waitingForKey, 1);
  assert.equal(d.stateHash(), s.stateHash);
});

test('restoreState round trips every observable machine field', () => {
  const c = machine([0x6107, 0x8F24, 0xD015, 0x1200], (x) => {
    x.setProfile('chip48');
    x.delayTimer = 33;
    x.soundTimer = 7;
    x.sp = 2;
    x.stack[0] = 0x240;
    x.stack[1] = 0x2AA;
    x.display[0] = 1;
    x.display[2047] = 1;
    x.keys[9] = 1;
    x.I = 0x300;
    x.memory[0x300] = 0xFF;
  });
  c.step();
  const s = c.snapshotState();
  const d = new Chip8();
  d.restoreState(s);
  assert.equal(d.stateHash(), s.stateHash);
  assert.equal(d.I, 0x300);
  assert.equal(d.display[2047], 1);
  assert.equal(d.keys[9], 1);
  assert.equal(d.quirks.jumpUsesVx, true);
});

test('restoreState accepts a parsed exportState JSON document', () => {
  const c = machine([0x6A55, 0x8B14]);
  c.step(); c.step();
  const d = new Chip8();
  d.restoreState(JSON.parse(c.exportState()));
  assert.equal(d.stateHash(), c.stateHash());
  assert.equal(d.V[0xA], 0x55);
  assert.equal(d.V[0xB], 0); // 8B14 added V4 (zero) into VB
});

test('exportState returns indented parseable JSON', () => {
  const c = machine([0x6001]);
  const text = c.exportState();
  assert.ok(text.includes('\n'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'chipper8-snapshot');
  assert.equal(parsed.pc, 0x200);
});

test('restoreState rejects wrong formats and non objects', () => {
  const c = new Chip8();
  for (const bad of [null, 5, 'x', {}, { format: 'other' }, { format: 'chipper8-snapshot', version: 9 }]) {
    assert.throws(() => c.restoreState(bad), RangeError, JSON.stringify(bad));
  }
});

test('restoreState rejects out of range field values', () => {
  const c = machine([0x6001]);
  const s = c.snapshotState();
  // Each tweak runs on a live machine so the corrupted snapshot still
  // carries a self-consistent hash: rejection proves the field checks run,
  // not just the hash gate.
  const tweaks = [
    (x) => { x.pc = -4; },
    (x) => { x.I = 0x1000; },
    (x) => { x.sp = 17; },
    (x) => { x.stack = new Array(16).fill(0); x.stack[0] = 0x1FFFF; },
    (x) => { x.stack = new Array(15).fill(0); },
    (x) => { x.keys[4] = 2; },
    (x) => { x.halted = 'yes'; },
    (x) => { x.drawFlag = 'yes'; },
    (x) => { x.error = 5; },
    (x) => { x.delayTimer = 300; },
    (x) => { x.soundTimer = 700; },
    (x) => { x.instructionsExecuted = -1; },
    (x) => { x.traceCyclePhase = -5; },
    (x) => { x.traceCyclePhase = 1.5; },
    (x) => { x.waitingForKey = 16; },
    (x) => { x.V = new Array(15).fill(0); },
    (x) => { x.V = new Array(16).fill(0); x.V[0] = 300; },
    (x) => { x.keys = new Array(15).fill(0); }
  ];
  for (const tweak of tweaks) {
    const scratch = new Chip8();
    scratch.restoreState(s);
    tweak(scratch);
    const mutated = scratch.snapshotState();
    const receiver = machine([0x60, 0x77]);
    const before = receiver.exportState();
    assert.throws(() => receiver.restoreState(mutated), RangeError, tweak.toString());
    assert.equal(receiver.exportState(), before, tweak.toString());
  }
});

test('restoreState rejects corrupt packed hex fields', () => {
  const c = machine([0x6001]);
  const s = c.snapshotState();
  for (const mutate of [
    (x) => { x.memory = x.memory.slice(0, -2); },
    (x) => { x.memory = 'zz' + x.memory.slice(2); },
    (x) => { x.vram = x.vram.slice(0, -2); },
    (x) => { x.vram = 'qq' + x.vram.slice(2); }
  ]) {
    const copy = JSON.parse(JSON.stringify(s));
    mutate(copy);
    assert.throws(() => new Chip8().restoreState(copy), RangeError);
  }
});

test('restoreState rejects a snapshot whose embedded hash was tampered', () => {
  const c = machine([0x6001]);
  const s = JSON.parse(c.exportState());
  s.v[2] = 0x99; // state changed but stateHash left stale
  assert.throws(() => new Chip8().restoreState(s), /hash mismatch/);
});

test('trace records fetch pc, raw word, mnemonic and post state fields', () => {
  const c = machine([0x6105, 0x8124, 0x1200]);
  const r = c.trace(2);
  assert.equal(r.entries.length, 2);
  const e = r.entries[0];
  assert.equal(e.pc, 0x200);
  assert.equal(e.op, 0x6105);
  assert.equal(e.mnemonic, 'LD V1, 0x05');
  assert.equal(e.n, 1);
  assert.match(e.h, /^[0-9a-f]{8}$/);
  assert.equal(r.entries[1].op, 0x8124);
});

test('trace stops recording at the halt instead of padding the buffer', () => {
  const c = machine([0x8FF9]); // unassigned nibble faults on first step
  const r = c.trace(10);
  assert.equal(r.entries.length, 1);
  assert.equal(r.halted, true);
  assert.match(r.error, /Unknown opcode/);
});

test('trace reports blocked FX0A fetches only when asked for stalls', () => {
  const c = machine([0xF10A]);
  const quiet = c.trace(5);
  assert.equal(quiet.entries.length, 0);
  const loud = machine([0xF10A]).trace(5, { includeStalls: true });
  assert.equal(loud.entries.length, 5);
  assert.equal(loud.entries[0].stall, true);
  assert.equal(loud.entries[0].pc, 0x200);
});

test('traceProgram is byte identical across runs for the same seed', () => {
  const pong = roms.find((r) => r.id === 'pong');
  const a = Chip8.traceProgram(pong.bytes, 400, { seed: 7 });
  const b = Chip8.traceProgram(pong.bytes, 400, { seed: 7 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.finalHash, b.finalHash);
  assert.ok(a.instructions > 0);
});

test('traceProgram diverges on CXKK when the seed differs', () => {
  const rom = [0xC0, 0xFF, 0xC1, 0xFF, 0xC2, 0xFF, 0x12, 0x00];
  const a = Chip8.traceProgram(rom, 4, { seed: 1 });
  const b = Chip8.traceProgram(rom, 4, { seed: 999 });
  assert.notEqual(a.finalHash, b.finalHash);
});

test('traceProgram honors the requested quirk profile', () => {
  const rom = [0x61, 0x09, 0x62, 0x06, 0x81, 0x26];
  const modern = Chip8.traceProgram(rom, 3, { profile: 'modern' });
  const vip = Chip8.traceProgram(rom, 3, { profile: 'vip' });
  assert.notEqual(modern.finalHash, vip.finalHash);
  assert.equal(vip.entries[2].vf, 0);   // vip shifts V2: VF = 6 & 1
  assert.equal(modern.entries[2].vf, 1); // modern shifts V1: VF = 9 & 1
});

test('traceProgram finalHash equals the live machine hash after the same run', () => {
  const rom = [0x60, 0x07, 0x61, 0x09, 0x80, 0x14];
  const report = Chip8.traceProgram(rom, 3, { seed: 5 });
  const c = new Chip8();
  c.rng = Chip8.seededRng(5);
  c.load(rom);
  c.step(); c.step(); c.step();
  assert.equal(report.finalHash, c.stateHash());
});

test('per entry full-state hash matches identical runs and diverges on divergence', () => {
  const a = machine([0x6001, 0x6101]);
  const b = machine([0x6001, 0x6101]);
  const c = machine([0x6001, 0x6102]);
  const ta = a.trace(2), tb = b.trace(2), tc = c.trace(2);
  assert.equal(ta.entries[0].h, tb.entries[0].h);   // identical machines agree
  assert.equal(ta.entries[1].h, tb.entries[1].h);
  assert.notEqual(ta.entries[0].h, tc.entries[0].h); // ROM image differs in RAM
  assert.notEqual(ta.entries[1].h, tc.entries[1].h); // register result diverges too
});

test('trace result carries quirk flags, counts and diagnostics', () => {
  const c = machine([0x0123], (x) => x.setProfile('vip'));
  const r = c.trace(1);
  assert.equal(r.format, 'chipper8-trace');
  assert.equal(r.quirks.shiftUsesVy, true);
  assert.equal(r.instructions, 1);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].code, 'SYS_NOP');
});

test('trace with zero steps returns an empty entry list', () => {
  const r = machine([0x6001]).trace(0);
  assert.equal(r.entries.length, 0);
  assert.equal(r.instructions, 0);
});

test('trace rejects negative and non integer step counts', () => {
  const c = new Chip8();
  for (const steps of [-1, 2.5, NaN, 'four']) {
    assert.throws(() => c.trace(steps), RangeError, String(steps));
  }
});

test('traceProgram reports ROM byte size, seed and profile in meta', () => {
  const r = Chip8.traceProgram([0x00, 0xE0], 1, { seed: 42, profile: 'vip' });
  assert.equal(r.meta.romBytes, 2);
  assert.equal(r.meta.seed, 42);
  assert.equal(r.meta.profile, 'vip');
});

test('traceProgram validates seeds and quirk flag types', () => {
  assert.throws(() => Chip8.traceProgram([0x00, 0xE0], 1, { seed: -2 }), RangeError);
  assert.throws(() => Chip8.traceProgram([0x00, 0xE0], 1, { quirks: { clipSprites: 'yes' } }), RangeError);
  assert.throws(() => Chip8.traceProgram([0x00, 0xE0], 1, { profile: 'nope' }), RangeError);
});

test('a custom override set changes the trace without a named profile', () => {
  const rom = [0xF1, 0x55];
  const vipStyle = Chip8.traceProgram(rom, 1, { quirks: { loadStoreNoIncrementI: true } });
  const vanilla = Chip8.traceProgram(rom, 1, {});
  assert.notEqual(vipStyle.finalHash, vanilla.finalHash);
  assert.equal(vipStyle.quirks.loadStoreNoIncrementI, true);
});

test('assembled source traces the same path as its byte image', () => {
  const bytes = assemble('LD V0, 7\nJP 0x202');
  const report = Chip8.traceProgram(bytes, 3);
  assert.equal(report.entries[0].mnemonic, 'LD V0, 0x07');
  assert.equal(report.entries[1].pc, 0x202);
});

test('snapshot carries the timer cycle phase into the hash and the restore', () => {
  // LD V0,1; LD DT,V0; LD V1,0; LD V1,DT. After three edges at two cycles
  // per tick the phase sits mid-interval; losing it makes the restored
  // machine read DT one 60 Hz tick early.
  const c = machine([0x6001, 0xF015, 0x6100, 0xF107]);
  c.trace(3, { cyclesPerTick: 2 });
  const s = c.snapshotState();
  assert.equal(s.traceCyclePhase, 1);
  const d = new Chip8();
  d.restoreState(s);
  assert.equal(d.traceCyclePhase, 1);
  assert.equal(d.stateHash(), s.stateHash);
  c.trace(1, { cyclesPerTick: 2 });
  d.trace(1, { cyclesPerTick: 2 });
  assert.equal(d.V[1], c.V[1]);
  assert.equal(d.V[1], 0);
  assert.equal(d.delayTimer, c.delayTimer);
  assert.equal(d.soundTimer, c.soundTimer);
  assert.equal(d.stateHash(), c.stateHash());
});

test('the timer cycle phase participates in the canonical state hash', () => {
  const a = machine([0x6001]); a.traceCyclePhase = 3;
  const b = machine([0x6001]); b.traceCyclePhase = 4;
  assert.notEqual(a.stateHash(), b.stateHash());
});
