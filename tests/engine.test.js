'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');

// Build a fresh CPU, optionally write one opcode at 0x200, and step once.
function cpu() {
  const c = new Chip8();
  c.reset();
  return c;
}

function write(c, opcode, addr = 0x200) {
  c.memory[addr] = (opcode >> 8) & 0xFF;
  c.memory[addr + 1] = opcode & 0xFF;
  return c;
}

// Place a single opcode at pc and execute it, returning the cpu.
function run(opcode, seed) {
  const c = cpu();
  if (seed) { seed(c); }
  write(c, opcode, c.pc);
  c.step();
  return c;
}

test('reset: pc starts at 0x200 and fontset is in memory', () => {
  const c = cpu();
  assert.equal(c.pc, 0x200);
  assert.equal(c.memory[0], 0xF0); // first byte of the "0" sprite
  assert.equal(c.memory[4], 0xF0);
  assert.equal(c.memory[5], 0x20); // first byte of the "1" sprite
  assert.equal(c.I, 0);
  assert.equal(c.sp, 0);
  assert.equal(c.delayTimer, 0);
  assert.equal(c.soundTimer, 0);
});

test('reset: display, registers, keys and stack are zeroed', () => {
  const c = cpu();
  c.V[3] = 9;
  c.keys[2] = 1;
  c.stack[0] = 0xABC;
  c.display[10] = 1;
  c.reset();
  assert.equal(c.V[3], 0);
  assert.equal(c.keys[2], 0);
  assert.equal(c.stack[0], 0);
  assert.equal(c.display[10], 0);
});

test('load: ROM bytes land at 0x200 and pc resets to 0x200', () => {
  const c = cpu();
  c.pc = 0x300;
  c.load([0x12, 0x34, 0xAB]);
  assert.equal(c.memory[0x200], 0x12);
  assert.equal(c.memory[0x201], 0x34);
  assert.equal(c.memory[0x202], 0xAB);
  assert.equal(c.pc, 0x200);
});

test('00E0 - CLS clears the display and sets drawFlag', () => {
  const c = cpu();
  c.display.fill(1);
  c.drawFlag = false;
  write(c, 0x00E0);
  c.step();
  assert.equal(c.display.some((p) => p === 1), false);
  assert.equal(c.drawFlag, true);
});

test('00EE - RET pops the stack into pc', () => {
  const c = cpu();
  c.stack[0] = 0x312;
  c.sp = 1;
  write(c, 0x00EE);
  c.step();
  assert.equal(c.pc, 0x312);
  assert.equal(c.sp, 0);
});

test('0NNN - SYS is a no-op except for advancing pc', () => {
  const c = run(0x0123);
  assert.equal(c.pc, 0x202);
  assert.equal(c.halted, false);
});

test('1NNN - JP addr jumps to nnn', () => {
  const c = run(0x1ABC);
  assert.equal(c.pc, 0xABC);
});

test('2NNN - CALL pushes the return address and jumps', () => {
  const c = run(0x2ABC);
  assert.equal(c.pc, 0xABC);
  assert.equal(c.sp, 1);
  assert.equal(c.stack[0], 0x202);
});

test('2NNN + 00EE - CALL then RET round trips', () => {
  const c = cpu();
  write(c, 0x2220);
  c.step(); // call 0x220
  write(c, 0x00EE, 0x220);
  c.step(); // ret
  assert.equal(c.pc, 0x202);
  assert.equal(c.sp, 0);
});

test('3XKK - SE Vx, byte skips when equal', () => {
  const c = run(0x3055, (x) => { x.V[0] = 0x55; });
  assert.equal(c.pc, 0x204);
});

test('3XKK - SE Vx, byte does not skip when different', () => {
  const c = run(0x3055, (x) => { x.V[0] = 0x56; });
  assert.equal(c.pc, 0x202);
});

test('4XKK - SNE Vx, byte skips when different', () => {
  const c = run(0x4055, (x) => { x.V[0] = 0x56; });
  assert.equal(c.pc, 0x204);
});

test('4XKK - SNE Vx, byte does not skip when equal', () => {
  const c = run(0x4055, (x) => { x.V[0] = 0x55; });
  assert.equal(c.pc, 0x202);
});

test('5XY0 - SE Vx, Vy skips when registers equal', () => {
  const c = run(0x5120, (x) => { x.V[1] = 0x44; x.V[2] = 0x44; });
  assert.equal(c.pc, 0x204);
});

test('5XY0 - SE Vx, Vy does not skip when different', () => {
  const c = run(0x5120, (x) => { x.V[1] = 0x44; x.V[2] = 0x45; });
  assert.equal(c.pc, 0x202);
});

test('6XKK - LD Vx, byte', () => {
  const c = run(0x6A7F);
  assert.equal(c.V[0xA], 0x7F);
});

test('7XKK - ADD Vx, byte wraps without touching VF', () => {
  const c = run(0x7AFF, (x) => { x.V[0xA] = 0x02; x.V[0xF] = 7; });
  assert.equal(c.V[0xA], 0x01); // 2 + 255 = 257 -> 1
  assert.equal(c.V[0xF], 7);     // VF unchanged (no carry semantics)
});

test('8XY0 - LD Vx, Vy', () => {
  const c = run(0x8120, (x) => { x.V[2] = 0x9C; });
  assert.equal(c.V[1], 0x9C);
});

test('8XY1 - OR Vx, Vy', () => {
  const c = run(0x8121, (x) => { x.V[1] = 0xF0; x.V[2] = 0x0F; });
  assert.equal(c.V[1], 0xFF);
});

test('8XY2 - AND Vx, Vy', () => {
  const c = run(0x8122, (x) => { x.V[1] = 0xF0; x.V[2] = 0x3C; });
  assert.equal(c.V[1], 0x30);
});

test('8XY3 - XOR Vx, Vy', () => {
  const c = run(0x8123, (x) => { x.V[1] = 0xAA; x.V[2] = 0x0F; });
  assert.equal(c.V[1], 0xA5);
});

test('8XY4 - ADD Vx, Vy sets VF on carry', () => {
  const c = run(0x8124, (x) => { x.V[1] = 0xFF; x.V[2] = 0x01; });
  assert.equal(c.V[1], 0x00);
  assert.equal(c.V[0xF], 1);
});

test('8XY4 - ADD Vx, Vy clears VF without carry', () => {
  const c = run(0x8124, (x) => { x.V[1] = 0x10; x.V[2] = 0x20; x.V[0xF] = 1; });
  assert.equal(c.V[1], 0x30);
  assert.equal(c.V[0xF], 0);
});

test('8XY5 - SUB Vx, Vy sets VF when no borrow', () => {
  const c = run(0x8125, (x) => { x.V[1] = 0x10; x.V[2] = 0x05; });
  assert.equal(c.V[1], 0x0B);
  assert.equal(c.V[0xF], 1);
});

test('8XY5 - SUB Vx, Vy clears VF on borrow and wraps', () => {
  const c = run(0x8125, (x) => { x.V[1] = 0x01; x.V[2] = 0x02; x.V[0xF] = 1; });
  assert.equal(c.V[1], 0xFF);
  assert.equal(c.V[0xF], 0);
});

test('8XY6 - SHR Vx sets VF to the old LSB', () => {
  const c = run(0x8126, (x) => { x.V[1] = 0x0F; });
  assert.equal(c.V[1], 0x07);
  assert.equal(c.V[0xF], 1);
});

test('8XY6 - SHR Vx clears VF when the old LSB is 0', () => {
  const c = run(0x8126, (x) => { x.V[1] = 0x04; x.V[0xF] = 1; });
  assert.equal(c.V[1], 0x02);
  assert.equal(c.V[0xF], 0);
});

test('8XY7 - SUBN Vx, Vy (Vy - Vx) sets VF when no borrow', () => {
  const c = run(0x8127, (x) => { x.V[1] = 0x05; x.V[2] = 0x10; });
  assert.equal(c.V[1], 0x0B);
  assert.equal(c.V[0xF], 1);
});

test('8XY7 - SUBN Vx, Vy clears VF when Vx > Vy', () => {
  const c = run(0x8127, (x) => { x.V[1] = 0x10; x.V[2] = 0x05; x.V[0xF] = 1; });
  assert.equal(c.V[1], 0xF5);
  assert.equal(c.V[0xF], 0);
});

test('8XYE - SHL Vx sets VF to the old MSB and wraps', () => {
  const c = run(0x812E, (x) => { x.V[1] = 0x81; });
  assert.equal(c.V[1], 0x02);
  assert.equal(c.V[0xF], 1);
});

test('8XYE - SHL Vx clears VF when the old MSB is 0', () => {
  const c = run(0x812E, (x) => { x.V[1] = 0x01; x.V[0xF] = 1; });
  assert.equal(c.V[1], 0x02);
  assert.equal(c.V[0xF], 0);
});

test('9XY0 - SNE Vx, Vy skips when registers differ', () => {
  const c = run(0x9120, (x) => { x.V[1] = 0x44; x.V[2] = 0x45; });
  assert.equal(c.pc, 0x204);
});

test('9XY0 - SNE Vx, Vy does not skip when equal', () => {
  const c = run(0x9120, (x) => { x.V[1] = 0x44; x.V[2] = 0x44; });
  assert.equal(c.pc, 0x202);
});

test('ANNN - LD I, addr', () => {
  const c = run(0xAFFF);
  assert.equal(c.I, 0xFFF);
});

test('BNNN - JP V0, addr', () => {
  const c = run(0xB300, (x) => { x.V[0] = 0x10; });
  assert.equal(c.pc, 0x310);
});

test('CXKK - RND Vx, byte masks a deterministic random value', () => {
  const c = cpu();
  c.rng = () => 0.5; // 0.5 * 256 = 128 = 0x80
  write(c, 0xC10F, c.pc);
  c.step();
  assert.equal(c.V[1], 0x80 & 0x0F); // 0x00
  const c2 = cpu();
  c2.rng = () => 0.5;
  write(c2, 0xC1FF, c2.pc);
  c2.step();
  assert.equal(c2.V[1], 0x80);
});

test('DXYN - DRW draws a sprite via XOR', () => {
  const c = cpu();
  c.V[0] = 0; c.V[1] = 0;
  c.I = 0x300;
  c.memory[0x300] = 0xF0; // 11110000
  write(c, 0xD011, c.pc); // draw 8x1 at (0,0)
  c.step();
  assert.equal(c.getPixel(0, 0), 1);
  assert.equal(c.getPixel(1, 0), 1);
  assert.equal(c.getPixel(2, 0), 1);
  assert.equal(c.getPixel(3, 0), 1);
  assert.equal(c.getPixel(4, 0), 0);
  assert.equal(c.V[0xF], 0); // no collision
  assert.equal(c.drawFlag, true);
});

test('DXYN - DRW sets VF on collision (erasing a lit pixel)', () => {
  const c = cpu();
  c.V[0] = 0; c.V[1] = 0;
  c.I = 0x300;
  c.memory[0x300] = 0xFF;
  c.display[2] = 1; // pre-lit pixel under the sprite
  write(c, 0xD011, c.pc);
  c.step();
  assert.equal(c.V[0xF], 1);
  assert.equal(c.getPixel(2, 0), 0); // toggled off
  assert.equal(c.getPixel(0, 0), 1);
});

test('DXYN - DRW wraps sprite coordinates around the screen edge', () => {
  const c = cpu();
  c.V[0] = 63; c.V[1] = 31; // bottom-right corner
  c.I = 0x300;
  c.memory[0x300] = 0x80; // one lit pixel at the leftmost bit
  write(c, 0xD011, c.pc);
  c.step();
  assert.equal(c.getPixel(63, 31), 1);
  assert.equal(c.getPixel(0, 31), 0); // col 1 is at x=0 -> bit is 0, so still 0
});

test('DXYN - DRW draws multiple sprite rows', () => {
  const c = cpu();
  c.V[0] = 0; c.V[1] = 0;
  c.I = 0x300;
  c.memory[0x300] = 0x80;
  c.memory[0x301] = 0x40;
  write(c, 0xD012, c.pc); // 2 rows
  c.step();
  assert.equal(c.getPixel(0, 0), 1);
  assert.equal(c.getPixel(1, 1), 1);
});

test('EX9E - SKP Vx skips when the key is down', () => {
  const c = run(0xE19E, (x) => { x.V[1] = 0x5; x.keys[5] = 1; });
  assert.equal(c.pc, 0x204);
});

test('EX9E - SKP Vx does not skip when the key is up', () => {
  const c = run(0xE19E, (x) => { x.V[1] = 0x5; });
  assert.equal(c.pc, 0x202);
});

test('EXA1 - SKNP Vx skips when the key is up', () => {
  const c = run(0xE1A1, (x) => { x.V[1] = 0x5; });
  assert.equal(c.pc, 0x204);
});

test('EXA1 - SKNP Vx does not skip when the key is down', () => {
  const c = run(0xE1A1, (x) => { x.V[1] = 0x5; x.keys[5] = 1; });
  assert.equal(c.pc, 0x202);
});

test('FX07 - LD Vx, DT reads the delay timer', () => {
  const c = run(0xF107, (x) => { x.delayTimer = 42; });
  assert.equal(c.V[1], 42);
});

test('FX0A - LD Vx, K blocks (rewinds pc) until a key is down', () => {
  const c = cpu();
  write(c, 0xF10A, c.pc);
  c.step();
  assert.equal(c.pc, 0x200); // still waiting
  c.keys[0xC] = 1;
  c.step();
  assert.equal(c.V[1], 0xC);
  assert.equal(c.pc, 0x202);
});

test('FX15 - LD DT, Vx', () => {
  const c = run(0xF115, (x) => { x.V[1] = 30; });
  assert.equal(c.delayTimer, 30);
});

test('FX18 - LD ST, Vx', () => {
  const c = run(0xF118, (x) => { x.V[1] = 25; });
  assert.equal(c.soundTimer, 25);
});

test('FX1E - ADD I, Vx', () => {
  const c = run(0xF11E, (x) => { x.I = 0x300; x.V[1] = 0x10; });
  assert.equal(c.I, 0x310);
});

test('FX29 - LD F, Vx points at the digit font sprite', () => {
  const c = run(0xF129, (x) => { x.V[1] = 0xA; });
  assert.equal(c.I, 0xA * 5); // 50
  assert.equal(c.memory[c.I], 0xF0); // first row of "A"
});

test('Fx33 - BCD stores hundreds, tens, ones for 156', () => {
  const c = run(0xF133, (x) => { x.V[1] = 156; x.I = 0x300; });
  assert.equal(c.memory[0x300], 1);
  assert.equal(c.memory[0x301], 5);
  assert.equal(c.memory[0x302], 6);
});

test('Fx33 - BCD stores leading zeros for 7', () => {
  const c = run(0xF233, (x) => { x.V[2] = 7; x.I = 0x400; });
  assert.equal(c.memory[0x400], 0);
  assert.equal(c.memory[0x401], 0);
  assert.equal(c.memory[0x402], 7);
});

test('Fx33 - BCD handles the maximum value 255', () => {
  const c = run(0xF033, (x) => { x.V[0] = 255; x.I = 0x500; });
  assert.equal(c.memory[0x500], 2);
  assert.equal(c.memory[0x501], 5);
  assert.equal(c.memory[0x502], 5);
});

test('Fx33 - BCD handles zero', () => {
  const c = run(0xF033, (x) => { x.V[0] = 0; x.I = 0x500; });
  assert.equal(c.memory[0x500], 0);
  assert.equal(c.memory[0x501], 0);
  assert.equal(c.memory[0x502], 0);
});

test('FX55 - LD [I], V0..Vx stores registers and advances I', () => {
  const c = run(0xF255, (x) => {
    x.I = 0x300;
    x.V[0] = 0x11; x.V[1] = 0x22; x.V[2] = 0x33;
  });
  assert.equal(c.memory[0x300], 0x11);
  assert.equal(c.memory[0x301], 0x22);
  assert.equal(c.memory[0x302], 0x33);
  assert.equal(c.I, 0x303);
});

test('FX65 - LD V0..Vx, [I] loads registers and advances I', () => {
  const c = run(0xF265, (x) => {
    x.I = 0x300;
    c_memory(x);
  });
  assert.equal(c.V[0], 0xAA);
  assert.equal(c.V[1], 0xBB);
  assert.equal(c.V[2], 0xCC);
  assert.equal(c.I, 0x303);
});

function c_memory(x) {
  x.memory[0x300] = 0xAA;
  x.memory[0x301] = 0xBB;
  x.memory[0x302] = 0xCC;
}

test('FX55 quirk: loadStoreNoIncrementI leaves I unchanged', () => {
  const c = cpu();
  c.quirks.loadStoreNoIncrementI = true;
  c.I = 0x300;
  c.V[0] = 0x42;
  write(c, 0xF055, c.pc);
  c.step();
  assert.equal(c.memory[0x300], 0x42);
  assert.equal(c.I, 0x300);
});

test('tickTimers decrements both timers and stops at zero', () => {
  const c = cpu();
  c.delayTimer = 2;
  c.soundTimer = 1;
  c.tickTimers();
  assert.equal(c.delayTimer, 1);
  assert.equal(c.soundTimer, 0);
  c.tickTimers();
  assert.equal(c.delayTimer, 0);
  assert.equal(c.soundTimer, 0);
  c.tickTimers();
  assert.equal(c.delayTimer, 0); // never negative
});

test('setKey toggles a key on and off and ignores out-of-range keys', () => {
  const c = cpu();
  c.setKey(0xE, true);
  assert.equal(c.keys[0xE], 1);
  c.setKey(0xE, false);
  assert.equal(c.keys[0xE], 0);
  c.setKey(99, true); // no throw, no effect
  assert.equal(c.keys.length, 16);
});

test('step advances pc by two for a normal instruction', () => {
  const c = run(0x6001);
  assert.equal(c.pc, 0x202);
  assert.equal(c.lastOpcode, 0x6001);
});

test('unknown opcode under 8XY? halts the CPU', () => {
  const c = run(0x8129); // 8XY9 is not a valid instruction
  assert.equal(c.halted, true);
});

test('disassemble returns readable mnemonics for representative opcodes', () => {
  const c = cpu();
  assert.equal(c.disassemble(0x00E0), 'CLS');
  assert.equal(c.disassemble(0x00EE), 'RET');
  assert.equal(c.disassemble(0x1ABC), 'JP 0xABC');
  assert.equal(c.disassemble(0x6A7F), 'LD VA, 0x7F');
  assert.equal(c.disassemble(0xD011), 'DRW V0, V1, 1');
  assert.equal(c.disassemble(0xF133), 'LD B, V1');
  assert.equal(c.disassemble(0xF00A), 'LD V0, K');
});

test('Chip8 exposes constants for the display and memory layout', () => {
  assert.equal(Chip8.DISPLAY_WIDTH, 64);
  assert.equal(Chip8.DISPLAY_HEIGHT, 32);
  assert.equal(Chip8.MEMORY_SIZE, 4096);
  assert.equal(Chip8.PROGRAM_START, 0x200);
  assert.equal(Chip8.FONTSET.length, 80);
});
