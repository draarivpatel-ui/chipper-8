'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');
const { assemble, assembleDetailed, AssemblerError } = require('../assembler.js');
const Clock = require('../clock.js');

function machine(opcode, configure = () => {}) {
  const c = new Chip8();
  c.load([opcode >> 8, opcode & 0xFF]);
  configure(c);
  c.step();
  return c;
}

// Bug 2: I is 12-bit, so FX1E wraps at 0xFFF.
test('FX1E wraps the 12-bit I register instead of growing past 0xFFF', () => {
  const c = machine(0xF11E, (x) => { x.I = 0xFFF; x.V[1] = 0x10; });
  assert.equal(c.I, 0x00F);
});

test('FX1E leaves VF unchanged across a wrapping addition', () => {
  const c = machine(0xF11E, (x) => { x.I = 0xFF0; x.V[1] = 0x20; x.V[15] = 7; });
  assert.equal(c.I, 0x010);
  assert.equal(c.V[15], 7);
});

// Bug 2: FX55/FX65 increment I with 12-bit wrap.
test('FX55 advances I with 12-bit wrap at the top of memory', () => {
  const c = machine(0xF155, (x) => { x.I = 0xFFF; x.V[0] = 0x42; x.V[1] = 0x99; });
  assert.equal(c.memory[0xFFF], 0x42);
  assert.equal(c.memory[0x000], 0x99); // store wraps inside memory
  assert.equal(c.I, 0x001);            // I = 0xFFF + 2 wraps to 0x001
});

test('FX65 advances I with 12-bit wrap at the top of memory', () => {
  const c = machine(0xF165, (x) => {
    x.I = 0xFFF; x.memory[0xFFF] = 0xAA; x.memory[0x000] = 0xBB;
  });
  assert.equal(c.V[0], 0xAA);
  assert.equal(c.V[1], 0xBB);
  assert.equal(c.I, 0x001);
});

// Bug 2: BNNN 12-bit wrap.
test('BNNN wraps the 12-bit PC target instead of jumping outside ROM space', () => {
  const c = machine(0xBFFF, (x) => { x.V[0] = 0x20; });
  assert.equal(c.pc, 0x01F);
  assert.equal(c.halted, false);
});

test('BXNN jumpUsesVx quirk also wraps at 0xFFF', () => {
  const c = machine(0xB123, (x) => { x.setProfile('chip48'); x.V[1] = 0xE0; });
  assert.equal(c.pc, 0x203); // 0x123 + 0xE0 = 0x203, within range, no wrap
  const d = machine(0xBFFF, (x) => { x.setProfile('chip48'); x.V[15] = 0x10; });
  assert.equal(d.pc, 0x00F); // 0xFFF + 0x10 wraps
});

// Bug 6: FX0A blocked fetch rewinds PC without going negative.
test('FX0A at address zero rewinds to a valid 12-bit PC', () => {
  const c = new Chip8();
  c.pc = 0;
  c.memory[0] = 0xF1; c.memory[1] = 0x0A;
  c.step();
  assert.equal(c.pc, 0); // blocked fetch rewinds from pc+2 back to 0
  assert.equal(c.instructionsExecuted, 0);
  assert.equal(c.halted, false);
});

// Bug 1: assembler labels are case-insensitive.
test('assembler resolves label references regardless of case', () => {
  assert.deepEqual([...assemble('Loop:\nJP loop')], [0x12, 0x00]);
  assert.deepEqual([...assemble('loop:\nJP Loop')], [0x12, 0x00]);
  assert.deepEqual([...assemble('Start: CLS\nJP start')], [0x00, 0xE0, 0x12, 0x00]);
});

test('assembler reports case-insensitive duplicate labels', () => {
  assert.throws(() => assemble('Loop: CLS\nloop: RET'), /duplicate label/);
});

test('assembler keeps original label spelling in detailed labels map for callers', () => {
  const d = assembleDetailed('checkCatch: CLS\nJP checkCatch');
  assert.equal(d.labels.checkCatch, 0x200);
  assert.equal(d.labels.checkcatch, 0x200);
});

// Bug 5: EX9E/EXA1 key index masking.
test('EX9E masks an out-of-range key value to four bits', () => {
  const c = machine(0xE19E, (x) => { x.V[1] = 0xFF; x.keys[0xF] = 1; });
  assert.equal(c.pc, 0x204); // tested key VF and skipped
});

test('EXA1 skips when the masked key is up', () => {
  const c = machine(0xE1A1, (x) => { x.V[1] = 0x10; x.keys[0] = 0; });
  assert.equal(c.pc, 0x204);
});

// Untested quirk combinations and boundaries.
test('all three profiles agree on arithmetic but differ on shifts and logic VF', () => {
  for (const name of ['modern', 'vip', 'chip48']) {
    const c = new Chip8().setProfile(name);
    c.load([0x61, 0x03, 0x62, 0x05, 0x81, 0x24]); // V1=3, V2=5, ADD V1,V2
    c.step(); c.step(); c.step();
    assert.equal(c.V[1], 8, name);
  }
});

test('VIP shiftUsesVy reads Vy even when Vx is VF (flag write wins)', () => {
  const c = new Chip8().setProfile('vip');
  c.load([0x8F, 0x16]); // SHR VF, V1 under VIP = V1 >> 1 into VF
  c.V[1] = 9; c.V[15] = 99;
  c.step();
  assert.equal(c.V[15], 1); // 9 >> 1 = 4 then VF = old V1 LSB = 1
});

test('logicResetsVf clears VF when Vx is VF', () => {
  const c = new Chip8().setProfile('vip');
  c.load([0x8F, 0x11]); // OR VF, V1
  c.V[1] = 0x30; c.V[15] = 0x05;
  c.step();
  assert.equal(c.V[15], 0); // result overwritten, then VF cleared
});

test('DXYN collision uses VF coordinates captured before VF is cleared', () => {
  const c = new Chip8();
  c.load([0xDF, 0x11]); // DRW VF, V1, 1
  c.V[15] = 20; c.V[1] = 4; c.I = 0x300; c.memory[0x300] = 0x80;
  c.step();
  assert.equal(c.getPixel(20, 4), 1);
  assert.equal(c.V[15], 0); // collision flag after draw
});

test('DXYN with VF as coordinates still clears VF even before drawing', () => {
  const c = new Chip8();
  c.load([0xDF, 0xF1]); // DRW VF, VF, 1
  c.V[15] = 10; c.I = 0x300; c.memory[0x300] = 0x80;
  c.step();
  assert.equal(c.getPixel(10, 10), 1);
});

test('clipSprites suppresses off-screen pixels at the right and bottom edges', () => {
  const c = new Chip8().setProfile('chip48');
  c.load([0xD0, 0x12]); c.V[0] = 63; c.V[1] = 31;
  c.I = 0x300; c.memory[0x300] = 0xFF; c.memory[0x301] = 0xFF;
  c.step();
  let count = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) count += c.getPixel(x, y);
  assert.equal(count, 1); // only pixel (63,31) survives
});

test('modern wrapping draws all 16 pixels at the bottom-right corner', () => {
  const c = new Chip8().setProfile('modern');
  c.load([0xD0, 0x12]); c.V[0] = 63; c.V[1] = 31;
  c.I = 0x300; c.memory[0x300] = 0xFF; c.memory[0x301] = 0xFF;
  c.step();
  let count = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) count += c.getPixel(x, y);
  assert.equal(count, 16);
});

test('malformed assembly: DB rejects a label whose address exceeds a byte', () => {
  assert.throws(() => assemble('here: DB here, 0x12'), /between 0 and 255/);
  const bytes = assemble('DW here, 0x1234\nhere: CLS'); // here = 0x204
  assert.deepEqual([...bytes], [0x02, 0x04, 0x12, 0x34, 0x00, 0xE0]);
});

test('malformed assembly: wrong operand counts are rejected for all families', () => {
  for (const src of ['CLS V0', 'RET V1', 'SYS', 'CALL', 'JPV0', 'SE V0', 'SNE V0', 'OR V0', 'AND V0', 'XOR V0', 'SUB V0', 'SUBN V0', 'RND V0', 'DRW V0,V1', 'SKP', 'SKNP', 'LD V0', 'ADD V0']) {
    assert.throws(() => assemble(src), AssemblerError, src);
  }
});

test('malformed assembly: out-of-range register operands are rejected', () => {
  for (const src of ['LD V10,1', 'LD VG,1', 'SE VZ,1', 'DRW V0,V1,16', 'SHR VF,VG', 'JP 0x1000', 'LD I,0x1000', 'DB 256', 'DW 65536']) {
    assert.throws(() => assemble(src), AssemblerError, src);
  }
});

test('clock: many small advances accumulate timer edges without drift', () => {
  const clock = new Clock(); let ticks = 0, ops = 0;
  for (let i = 0; i < 600; i++) clock.advance(1 / 600, 60, () => ops++, () => ticks++);
  assert.equal(ops, 60);
  assert.equal(ticks, 60);
});

test('clock: a large clock rate with a short frame stays within the event budget', () => {
  const clock = new Clock(); let ops = 0;
  clock.advance(0.05, 2000, () => ops++, () => {});
  assert.equal(ops, 100);
});

test('CPU timers never go negative even under repeated ticks', () => {
  const c = new Chip8();
  c.delayTimer = 1; c.soundTimer = 1;
  for (let i = 0; i < 10; i++) c.tickTimers();
  assert.equal(c.delayTimer, 0);
  assert.equal(c.soundTimer, 0);
});

test('ROM load rejects an empty source and preserves the running machine', () => {
  const c = new Chip8(); c.load([0x60, 7]); c.step();
  assert.throws(() => c.load([]), RangeError);
  assert.equal(c.V[0], 7);
});
