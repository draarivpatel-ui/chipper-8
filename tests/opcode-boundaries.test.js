'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');

function machine(word, configure) {
  const c = new Chip8();
  c.load([word >> 8, word & 0xFF]);
  if (configure) { configure(c); }
  c.step();
  return c;
}

test('every unassigned 8XY nibble faults instead of running', () => {
  for (const n of [0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0xF]) {
    const c = machine(0x8120 | n);
    assert.equal(c.halted, true, `8XY${n.toString(16)}`);
    assert.match(c.error, /Unknown opcode/);
  }
});

test('every EX word outside 9E and A1 faults', () => {
  for (const kk of [0x00, 0x9D, 0x9F, 0xA0, 0xA2, 0xFF]) {
    const c = machine(0xE100 | kk);
    assert.equal(c.halted, true, `EX kk=${kk.toString(16)}`);
  }
});

test('every FX word outside the nine assigned forms faults', () => {
  for (const kk of [0x00, 0x02, 0x0B, 0x14, 0x16, 0x1F, 0x30, 0x56, 0xFF]) {
    const c = machine(0xF100 | kk);
    assert.equal(c.halted, true, `FX kk=${kk.toString(16)}`);
  }
});

test('all fifteen malformed 5XYn and 9XYn skip words fault', () => {
  for (let n = 1; n <= 0xF; n++) {
    assert.equal(machine(0x5120 | n).halted, true, `5XY${n.toString(16)}`);
    assert.equal(machine(0x9120 | n).halted, true, `9XY${n.toString(16)}`);
  }
});

test('DRW with height zero draws nothing but still latches a frame', () => {
  const c = machine(0xD010, (x) => { x.display[100] = 1; });
  assert.equal(c.display[100], 1); // untouched
  assert.equal(c.drawFlag, true);
  assert.equal(c.V[0xF], 0);
});

test('DRW sprite bytes wrap the index read across the end of RAM', () => {
  const c = machine(0xD014, (x) => {
    x.V[0] = 0; x.V[1] = 0;
    x.I = 0xFFE;
    x.memory[0xFFE] = 0x80; // row 0 -> x=0,y=0
    x.memory[0xFFF] = 0x40; // row 1 -> x=1,y=1
    x.memory[0x000] = 0x20; // row 2 -> x=2,y=2 (wrapped read)
    x.memory[0x001] = 0x10; // row 3 -> x=3,y=3
  });
  for (const [px, py] of [[0, 0], [1, 1], [2, 2], [3, 3]]) {
    assert.equal(c.getPixel(px, py), 1, `${px},${py}`);
  }
});

test('DRW wraps a full row off the right edge back to column zero', () => {
  const c = machine(0xD011, (x) => {
    x.V[0] = 63; x.V[1] = 0;
    x.I = 0x300; x.memory[0x300] = 0xC0;
  });
  assert.equal(c.getPixel(63, 0), 1);
  assert.equal(c.getPixel(0, 0), 1); // second lit bit wrapped
});

test('DRW wraps a sprite row off the bottom edge back to row zero', () => {
  const c = machine(0xD012, (x) => {
    x.V[0] = 0; x.V[1] = 31;
    x.I = 0x300; x.memory[0x300] = 0x80; x.memory[0x301] = 0x80;
  });
  assert.equal(c.getPixel(0, 31), 1);
  assert.equal(c.getPixel(0, 0), 1); // second row wrapped to the top
});

test('DRW clip mode drops every off edge pixel and still counts collision', () => {
  const c = machine(0xD011, (x) => {
    x.setProfile('chip48');
    x.V[0] = 62; x.V[1] = 0;
    x.I = 0x300; x.memory[0x300] = 0xC0;
    x.display[62] = 1; // pre lit on screen pixel
  });
  assert.equal(c.getPixel(62, 0), 0); // erased: collision
  assert.equal(c.V[0xF], 1);
  assert.equal(c.getPixel(0, 0), 0); // wrapped bit would have landed here
});

test('FX55 stores only V0 when X is zero and advances I by one', () => {
  const c = machine(0xF055, (x) => { x.I = 0x300; x.V[0] = 0x7E; x.V[1] = 0x99; });
  assert.equal(c.memory[0x300], 0x7E);
  assert.equal(c.memory[0x301], 0);
  assert.equal(c.I, 0x301);
});

test('FX55 with X=F stores all sixteen registers exactly to 0xFFF', () => {
  const c = machine(0xFF55, (x) => {
    x.I = 0xFF0;
    for (let i = 0; i < 16; i++) { x.V[i] = i; }
  });
  for (let i = 0; i < 16; i++) { assert.equal(c.memory[0xFF0 + i], i); }
  assert.equal(c.I, 0x000); // 0xFF0 + 16 wraps to 0
});

test('FX65 with X=F loads all sixteen registers', () => {
  const c = machine(0xFF65, (x) => {
    x.I = 0x300;
    for (let i = 0; i < 16; i++) { x.memory[0x300 + i] = 0xA0 + i; }
  });
  for (let i = 0; i < 16; i++) { assert.equal(c.V[i], 0xA0 + i); }
  assert.equal(c.I, 0x310);
});

test('BNNN at the maximum offset wraps deep into the first page', () => {
  const c = machine(0xBFFF, (x) => { x.V[0] = 0xFF; });
  assert.equal(c.pc, 0x0FE); // 0xFFF + 0xFF = 0x10FE -> 0x0FE
});

test('BNNN with a zero offset lands exactly on NNN', () => {
  const c = machine(0xBABC);
  assert.equal(c.pc, 0xABC);
});

test('FX33 at the last byte of RAM wraps the BCD write to address zero', () => {
  const c = machine(0xF133, (x) => { x.I = 0xFFE; x.V[1] = 205; });
  assert.equal(c.memory[0xFFE], 2);
  assert.equal(c.memory[0xFFF], 0);
  assert.equal(c.memory[0x000], 5);
});

test('exactly sixteen nested calls fill the stack without faulting', () => {
  const c = new Chip8();
  // chain: each CALL targets the next call site, the last loops back to 0x200
  const program = [];
  for (let i = 0; i < 16; i++) {
    const target = i === 15 ? 0x200 : 0x202 + i * 2;
    program.push(0x2000 | target);
  }
  const flat = [];
  for (const w of program) { flat.push(w >> 8, w & 0xFF); }
  c.load(flat);
  for (let i = 0; i < 16; i++) { c.step(); }
  assert.equal(c.sp, 16);
  assert.equal(c.halted, false);
  c.step(); // seventeenth depth attempt: CALL at 0x200 again? sp already 16 -> overflow
  assert.equal(c.halted, true);
});

test('a skip at 0xFFC pushes the program counter past the fetchable range', () => {
  const c = new Chip8();
  c.load([0x12, 0x00]);
  c.memory[0xFFC] = 0x30; c.memory[0xFFD] = 0x00; // SE V0, 0 with V0=0 -> skip
  c.pc = 0xFFC;
  c.step();
  assert.equal(c.pc, 0x1000);
  c.step();
  assert.equal(c.halted, true);
  assert.match(c.error, /counter/);
});

test('7XKK treats VF as an ordinary operand register', () => {
  const c = machine(0x7F01, (x) => { x.V[0xF] = 0xFE; });
  assert.equal(c.V[0xF], 0xFF);
});

test('RND with a zero mask always yields zero', () => {
  const c = machine(0xC100, (x) => { x.rng = () => 0.9999; });
  assert.equal(c.V[1], 0);
});

test('RND with a full mask returns the raw sampled byte', () => {
  const c = machine(0xC1FF, (x) => { x.rng = () => 0.9999; });
  assert.equal(c.V[1], 255); // floor(0.9999 * 256) = 255
});

test('CALL at the last fetchable address pushes 0x1000 and faults on return', () => {
  const c = new Chip8();
  c.load([0x12, 0x00]);
  c.memory[0xFFE] = 0x22; c.memory[0xFFF] = 0x22; // CALL 0x222
  c.pc = 0xFFE;
  c.step();
  assert.equal(c.stack[0], 0x1000);
  assert.equal(c.pc, 0x222);
  c.memory[0x222] = 0x00; c.memory[0x223] = 0xEE;
  c.step(); // RET -> 0x1000
  c.step(); // fetch faults
  assert.equal(c.halted, true);
});

test('0xFFF is outside the fetchable range but 0xFFE is the last valid fetch', () => {
  const c = new Chip8();
  c.load([0x12, 0x00]);
  c.pc = 0xFFE;
  c.step(); // executes word at [0xFFE,0xFFF] = 0x0000 -> SYS nop
  assert.equal(c.halted, false);
  assert.equal(c.pc, 0x1000);
  c.step();
  assert.equal(c.halted, true);
});

test('FX0A completes with every one of the sixteen key values', () => {
  for (let key = 0; key < 16; key++) {
    const c = new Chip8();
    c.load([0xF1, 0x0A]);
    c.keys[key] = 1;
    c.step();
    assert.equal(c.V[1], key, `key ${key}`);
    assert.equal(c.pc, 0x202);
  }
});

test('a halted machine returns the last opcode without side effects', () => {
  const c = machine(0x8FF9);
  const haltedPc = c.pc;
  const haltedV = c.V.slice();
  const op = c.step();
  assert.equal(op, c.lastOpcode);
  assert.equal(c.pc, haltedPc);
  assert.deepEqual([...c.V], [...haltedV]);
  assert.equal(c.instructionsExecuted, 1);
});

test('3XKK and 4XKK boundaries at kk=0x00 and kk=0xFF on VF', () => {
  assert.equal(machine(0x3F00, (x) => { x.V[0xF] = 0; }).pc, 0x204);
  assert.equal(machine(0x3FFF, (x) => { x.V[0xF] = 0xFF; }).pc, 0x204);
  assert.equal(machine(0x4F00, (x) => { x.V[0xF] = 0; }).pc, 0x202);
  assert.equal(machine(0x4FFF, (x) => { x.V[0xF] = 0xFF; }).pc, 0x202);
});

test('register ops with X=Y=F read and write VF without a phantom operand', () => {
  const c = machine(0x8FF4, (x) => { x.V[0xF] = 0x80; });
  assert.equal(c.V[0xF], 1); // 0x80 + 0x80 -> carry
});
