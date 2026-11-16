'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');
const { assemble, assembleDetailed, AssemblerError } = require('../assembler.js');
const { list: roms } = require('../roms.js');
const Clock = require('../clock.js');
function execute(word, configure = () => {}) {
  const c = new Chip8(); c.load([word >> 8, word & 255]); configure(c); c.step(); return c;
}

test('arithmetic operands are captured before VF is written for every register pair', () => {
  for (const n of [4, 5, 6, 7, 14]) for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) {
    const c = new Chip8(); c.load([0x80 | x, (y << 4) | n]); c.V.fill(0x91); c.V[x] = 0xF3; c.V[y] = 0x0D;
    const vx = c.V[x], vy = c.V[y]; let result, flag;
    if (n === 4) { result = (vx + vy) & 255; flag = +(vx + vy > 255); }
    if (n === 5) { result = (vx - vy) & 255; flag = +(vx >= vy); }
    if (n === 7) { result = (vy - vx) & 255; flag = +(vy >= vx); }
    if (n === 6) { result = vx >> 1; flag = vx & 1; }
    if (n === 14) { result = (vx << 1) & 255; flag = vx >> 7; }
    c.step(); assert.equal(c.V[x], x === 15 ? flag : result, `x=${x}, y=${y}, n=${n}`); assert.equal(c.V[15], flag);
  }
});
test('VIP shift sources capture VF and equal register operands correctly', () => {
  const c = execute(0x81F6, c => { c.setProfile('vip'); c.V[1] = 8; c.V[15] = 7; });
  assert.equal(c.V[1], 3); assert.equal(c.V[15], 1);
});
test('drawing uses VF coordinates before clearing the collision flag', () => {
  const c = execute(0xDF11, c => { c.V[15] = 20; c.V[1] = 4; c.I = 0x300; c.memory[c.I] = 128; });
  assert.equal(c.getPixel(20, 4), 1); assert.equal(c.getPixel(0, 4), 0);
});
test('stack underflow halts with a useful fault', () => {
  const c = execute(0x00EE); assert.equal(c.halted, true); assert.match(c.error, /underflow/); assert.equal(c.sp, 0);
});
test('a seventeenth nested call faults without overwriting the stack', () => {
  const c = new Chip8(); c.load([0x22, 0x00]); for (let i = 0; i < 17; i++) c.step();
  assert.equal(c.sp, 16); assert.equal(c.halted, true); assert.match(c.error, /overflow/); assert.equal(c.stack[0], 0x202);
});
test('a program counter beyond the final byte faults instead of reading a zero opcode', () => {
  const c = execute(0x1FFF); c.step(); assert.equal(c.halted, true); assert.match(c.error, /counter/);
});
test('malformed register skip opcodes halt and disassemble as data', () => {
  for (const word of [0x5121, 0x912F]) { const c = execute(word); assert.equal(c.halted, true); assert.match(c.disassemble(word), /^DW/); }
});
test('ROM loading rejects invalid sizes and bytes before changing the machine', () => {
  const c = new Chip8(); c.load([0x60, 7]); c.step();
  for (const bytes of [[], new Uint8Array(3585), [256], [-1], [1.5], null]) assert.throws(() => c.load(bytes), RangeError);
  assert.equal(c.V[0], 7);
});
test('a shorter ROM clears stale registers, timers, display and trailing RAM', () => {
  const c = new Chip8(); c.load(new Uint8Array(100).fill(7)); c.V.fill(9); c.display.fill(1); c.delayTimer = 20;
  c.load([0x60, 3]); assert.equal(c.memory[0x220], 0); assert.equal(c.V[0], 0); assert.equal(c.delayTimer, 0); assert.equal(c.display.some(Boolean), false);
});
test('VIP key wait requires a fresh key press and release while timers remain independent', () => {
  const c = new Chip8().setProfile('vip'); c.load([0xF1, 0x0A]); c.setKey(2, true); c.step(); c.step();
  assert.equal(c.pc, 0x200); c.setKey(2, false); c.step(); assert.equal(c.pc, 0x200);
  c.setKey(5, true); c.step(); assert.equal(c.pc, 0x200); c.setKey(5, false); c.step(); assert.equal(c.V[1], 5); assert.equal(c.pc, 0x202);
  assert.equal(c.instructionsExecuted, 1);
});
test('held key mode still accepts key zero and does not count blocked fetches', () => {
  const c = new Chip8(); c.load([0xF1, 0x0A]); c.step(); assert.equal(c.instructionsExecuted, 0);
  c.setKey(0, true); c.step(); assert.equal(c.instructionsExecuted, 1); assert.equal(c.V[1], 0);
});
test('profiles set clipping, shift, offset jump and logic flag conventions', () => {
  const c = new Chip8().setProfile('chip48'); assert.equal(c.quirks.clipSprites, true); assert.equal(c.quirks.jumpUsesVx, true);
  c.setProfile('vip'); assert.equal(c.quirks.logicResetsVf, true); assert.equal(c.quirks.shiftUsesVy, true);
  assert.throws(() => c.setProfile('missing'), RangeError);
});
test('sprite clipping and wrapping differ at both screen edges', () => {
  for (const [profile, count] of [['modern', 16], ['chip48', 1]]) {
    const c = execute(0xD012, c => { c.setProfile(profile); c.V[0] = 63; c.V[1] = 31; c.I = 0x300; c.memory[0x300] = c.memory[0x301] = 255; });
    assert.equal(c.display.reduce((sum, bit) => sum + bit, 0), count);
  }
});
test('VIP logical operations reset VF while the modern profile retains it', () => {
  for (const [profile, expected] of [['vip', 0], ['modern', 7]]) {
    const c = execute(0x8121, c => { c.setProfile(profile); c.V[1] = 1; c.V[2] = 2; c.V[15] = 7; });
    assert.equal(c.V[1], 3); assert.equal(c.V[15], expected);
  }
});
test('all 65536 opcode words survive disassemble and assemble round trips', () => {
  const c = new Chip8(); for (let word = 0; word <= 65535; word++) {
    const bytes = assemble(c.disassemble(word)); assert.equal((bytes[0] << 8) | bytes[1], word);
  }
});
test('assembler rejects operand typos, incorrect arity and overflowing numeric values', () => {
  for (const source of ['LD VX, 5', 'SE A, 2', 'CLS V0', 'RET V1', 'SHR V0,V1,V2', 'LD V0,256', 'DRW V0,V1,16', 'JP 0x1000', 'DB 256', 'DW 65536', 'DB', 'LD DT,3', 'OR V0,2', 'LD V0,', 'JP V1,0x200']) {
    assert.throws(() => assemble(source), AssemblerError, source);
  }
});
test('assembler supports lowercase operands, forward labels and offset jumps', () => {
  assert.deepEqual([...assemble('ld v0, 5\nld i, sprite\njp v0, 0x220\nsprite: db 0x80')], [0x60, 5, 0xA2, 6, 0xB2, 0x20, 128]);
});
test('assembler details preserve source lines, symbols, data bytes and addresses', () => {
  const result = assembleDetailed('; note\nstart: LD V1,1\nJP start\npixel: DB 0x80');
  assert.equal(result.labels.start, 0x200); assert.equal(result.labels.pixel, 0x204);
  assert.deepEqual(result.listing.map(row => row.line), [2, 3, 4]); assert.equal(result.listing[2].address, 0x204);
});
test('assembler errors report the actual source line and invalid origins', () => {
  assert.throws(() => assemble('CLS\nLD VX,1'), /Line 2/);
  for (const origin of [-1, 4096, 1.2, Infinity]) assert.throws(() => assemble('CLS', origin), AssemblerError);
  assert.throws(() => assemble('a: CLS\na: RET'), /duplicate label/);
});
test('assembler honors exact ROM capacity and rejects overflow', () => {
  assert.equal(assemble('DB ' + Array(3584).fill('0').join(',')).length, 3584);
  assert.throws(() => assemble('DB ' + Array(3585).fill('0').join(',')), /too large/);
});
test('each original cartridge executes 5000 instructions without a CPU fault', () => {
  for (const rom of roms) {
    const c = new Chip8(); c.load(rom.bytes); c.rng = () => 0.3;
    for (let i = 0; i < 5000; i++) { c.step(); if (i % 10 === 0) c.tickTimers(); }
    assert.equal(c.halted, false, rom.name); assert.ok(c.display.some(Boolean), rom.name);
  }
});
test('Blaster draws an active projectile and leaves an idle projectile hidden', () => {
  const rom = roms.find(r => r.id === 'blaster'), details = assembleDetailed(rom.source);
  const c = new Chip8(); c.load(rom.bytes); c.pc = details.labels.draw; c.V[0] = 30; c.V[1] = 28; c.V[2] = 20; c.V[3] = 2; c.V[4] = 5; c.V[5] = 10;
  for (let i = 0; i < 10; i++) c.step(); assert.equal(c.getPixel(5, 10), 1);
  c.pc = details.labels.draw; c.V[5] = 255; for (let i = 0; i < 10; i++) c.step(); assert.equal(c.getPixel(5, 31), 0);
});
test('Catch counts the eight covered columns and excludes the ninth', () => {
  const rom = roms.find(r => r.id === 'catch'), labels = assembleDetailed(rom.source).labels;
  for (const [dot, expected] of [[20, 1], [27, 1], [28, 0], [19, 0]]) {
    const c = new Chip8(); c.load(rom.bytes); c.pc = labels.checkCatch; c.V[0] = dot; c.V[2] = 20;
    for (let i = 0; i < 14; i++) c.step(); assert.equal(c.V[7], expected, `dot=${dot}`);
  }
});
test('CPU instructions and 60 Hz timer edges are independent at 30, 60 and 144 frames per second', () => {
  for (const fps of [30, 60, 144]) {
    const clock = new Clock(); let ops = 0, ticks = 0;
    for (let i = 0; i < fps; i++) clock.advance(1 / fps, 600, () => { ops++; }, () => { ticks++; });
    assert.equal(ops, 600, `fps=${fps}`); assert.equal(ticks, 60);
  }
});
test('a timer edge precedes an instruction at the same timestamp', () => {
  const clock = new Clock(), events = []; clock.advance(1 / 60, 60, () => events.push('op'), () => events.push('timer'));
  assert.deepEqual(events, ['timer', 'op']);
});
test('clock preserves fractional work and rejects invalid durations and rates', () => {
  const clock = new Clock(); let ops = 0, ticks = 0;
  clock.advance(0.005, 100, () => ops++, () => ticks++); clock.advance(0.005, 100, () => ops++, () => ticks++);
  assert.equal(ops, 1); assert.equal(ticks, 0);
  for (const seconds of [-1, NaN, 2]) assert.throws(() => clock.advance(seconds, 600, () => {}, () => {}), RangeError);
  assert.throws(() => clock.advance(0.01, Infinity, () => {}, () => {}), RangeError);
});
test('assembler preserves single-letter lowercase labels i, b and f alongside register operands', () => {
  const bytes = assemble('i: CLS\nLD V0, 5\nb: JP i\nf: LD I, b\nJP f');
  assert.deepEqual([...bytes], [0x00, 0xE0, 0x60, 0x05, 0x12, 0x00, 0xA2, 0x04, 0x12, 0x06]);
});

