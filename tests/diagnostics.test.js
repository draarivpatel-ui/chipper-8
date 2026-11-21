'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');
const { list: roms } = require('../roms.js');

function machine(words, configure) {
  const bytes = [];
  for (const w of words) { bytes.push(w >> 8, w & 0xFF); }
  const c = new Chip8();
  c.load(bytes);
  if (configure) { configure(c); }
  return c;
}

function codes(cpu) { return cpu.diagnostics.map((d) => d.code); }

test('a fresh machine carries an empty diagnostic log and counts', () => {
  const c = new Chip8();
  assert.equal(c.diagnostics.length, 0);
  assert.equal(Object.keys(c.diagnosticCounts).length, 0);
});

test('diagnostic entries carry cycle, pc, code, severity and message', () => {
  const c = machine([0x0123]);
  c.step();
  const d = c.diagnostics[0];
  assert.equal(d.cycle, 1);
  assert.equal(d.pc, 0x200);
  assert.equal(d.code, 'SYS_NOP');
  assert.equal(d.severity, 'info');
  assert.match(d.message, /0x123/);
});

test('executing SYS records a no-op diagnostic every time', () => {
  const c = machine([0x0123, 0x0456]);
  c.step(); c.step();
  assert.deepEqual(codes(c), ['SYS_NOP', 'SYS_NOP']);
  assert.equal(c.diagnosticCounts.SYS_NOP, 2);
});

test('fetching below 0x200 records a low memory warning', () => {
  const c = machine([0x1000]);
  c.step(); // JP 0x000: lands inside the font area
  c.step(); // fetches 0xF0F0 -> unassigned FX word, faults
  assert.equal(c.diagnostics[0].code, 'LOW_MEM_FETCH');
  assert.equal(c.diagnostics[0].severity, 'warning');
  assert.equal(c.halted, true);
});

test('clipped sprites record a clip diagnostic under the clip quirk', () => {
  const c = machine([0xD012], (x) => {
    x.setProfile('chip48');
    x.V[0] = 63; x.V[1] = 31;
    x.I = 0x300; x.memory[0x300] = 0xFF; x.memory[0x301] = 0xFF;
  });
  c.step();
  assert.equal(c.diagnostics[0].code, 'SPRITE_CLIPPED');
  assert.equal(c.diagnosticCounts.SPRITE_CLIPPED, 1);
});

test('wrapped sprites record a wrap diagnostic under the modern profile', () => {
  const c = machine([0xD011], (x) => {
    x.V[0] = 63; x.V[1] = 0;
    x.I = 0x300; x.memory[0x300] = 0xC0; // two lit pixels: one on screen, one wraps
  });
  c.step();
  assert.equal(c.diagnostics[0].code, 'SPRITE_WRAPPED');
  assert.match(c.diagnostics[0].message, /1 sprite pixel/);
});

test('no sprite diagnostic fires when the draw stays on screen', () => {
  const c = machine([0xD011], (x) => {
    x.V[0] = 10; x.V[1] = 10; x.I = 0x300; x.memory[0x300] = 0xFF;
  });
  c.step();
  assert.equal(c.diagnostics.length, 0);
});

test('DRW with height zero records a zero height diagnostic', () => {
  const c = machine([0xD010]);
  c.step();
  assert.equal(c.diagnostics[0].code, 'DRW_ZERO_HEIGHT');
  assert.equal(c.drawFlag, true);
});

test('ADD I, Vx records an index wrap when the sum crosses 0xFFF', () => {
  const c = machine([0xF11E], (x) => { x.I = 0xFF0; x.V[1] = 0x20; });
  c.step();
  assert.equal(c.diagnostics[0].code, 'I_WRAP');
  assert.equal(c.I, 0x010);
});

test('FX55 and FX65 record a memory wrap past the end of RAM', () => {
  const store = machine([0xF155], (x) => { x.I = 0xFFF; x.V[0] = 1; x.V[1] = 2; });
  store.step();
  assert.equal(codes(store)[0], 'MEM_WRAP');
  const load = machine([0xF165], (x) => { x.I = 0xFFF; });
  load.step();
  assert.equal(codes(load)[0], 'MEM_WRAP');
});

test('BNNN records a program counter wrap past 0xFFF', () => {
  const c = machine([0xBFFF], (x) => { x.V[0] = 0x20; });
  c.step();
  assert.equal(codes(c)[0], 'PC_WRAP');
  assert.equal(c.pc, 0x01F);
});

test('key skip opcodes record a mask diagnostic for out of range keys', () => {
  const c = machine([0xE19E], (x) => { x.V[1] = 0x1F; });
  c.step();
  assert.equal(c.diagnostics[0].code, 'KEY_MASKED');
  assert.match(c.diagnostics[0].message, /masked to 15/);
});

test('unassigned opcodes fault with a BAD_OPCODE error diagnostic', () => {
  const c = machine([0x8FF9]);
  c.step();
  assert.equal(c.halted, true);
  const d = c.diagnostics[0];
  assert.equal(d.code, 'BAD_OPCODE');
  assert.equal(d.severity, 'error');
});

test('stack faults are coded underflow and overflow', () => {
  const under = machine([0x00EE]);
  under.step();
  assert.equal(under.diagnostics[0].code, 'STACK_UNDERFLOW');
  const over = machine([0x2200]);
  for (let i = 0; i < 17; i++) { over.step(); }
  assert.equal(over.diagnostics[0].code, 'STACK_OVERFLOW');
});

test('a program counter past the fetchable range is coded PC_RANGE', () => {
  const c = machine([0x1FFF]);
  c.step(); // JP 0xFFF
  c.step(); // fetch at 0xFFF faults
  assert.equal(c.diagnostics[0].code, 'PC_RANGE');
  assert.equal(c.diagnostics[0].severity, 'error');
});

test('the log stops growing past the cap but counts keep accumulating', () => {
  const c = new Chip8();
  for (let i = 0; i < Chip8.MAX_DIAGNOSTICS + 20; i++) {
    c.note('SYS_NOP', 'spam');
  }
  assert.equal(c.diagnostics.length, Chip8.MAX_DIAGNOSTICS);
  assert.equal(c.diagnosticCounts.SYS_NOP, Chip8.MAX_DIAGNOSTICS + 20);
});

test('reset and load clear the diagnostic log and counts', () => {
  const c = machine([0x0123]);
  c.step();
  assert.equal(c.diagnostics.length, 1);
  c.reset();
  assert.equal(c.diagnostics.length, 0);
  c.load([0x01, 0x23]);
  c.step();
  assert.equal(c.diagnostics.length, 1); // only the fresh SYS
});

test('runtime diagnostics ride along inside trace reports', () => {
  const c = machine([0x0123]);
  const r = c.trace(1);
  assert.equal(r.diagnostics[0].code, 'SYS_NOP');
});

test('validateRom passes a clean well formed cartridge', () => {
  const lint = Chip8.validateRom([0x00, 0xE0, 0x60, 0x01, 0x12, 0x00]);
  assert.equal(lint.ok, true);
  assert.equal(lint.errors, 0);
  assert.equal(lint.diagnostics.length, 0);
});

test('validateRom flags an odd byte count that truncates the last instruction', () => {
  const lint = Chip8.validateRom([0x00, 0xE0, 0x12]);
  assert.equal(lint.ok, true);
  assert.equal(lint.warnings, 1);
  assert.equal(lint.diagnostics[0].code, 'ODD_LENGTH');
  assert.equal(lint.diagnostics[0].offset, 0x202);
});

test('validateRom flags unassigned words as informational notes', () => {
  const lint = Chip8.validateRom([0x8F, 0xF9, 0xE1, 0x00]);
  assert.equal(lint.ok, true);
  assert.equal(lint.diagnostics.filter((d) => d.code === 'UNASSIGNED_WORD').length, 2);
  assert.equal(lint.diagnostics[0].offset, 0x200);
});

test('validateRom suppresses long runs of unassigned data words', () => {
  const bytes = [];
  for (let i = 0; i < 12; i++) { bytes.push(0x8F, 0xF9); }
  const lint = Chip8.validateRom(bytes);
  const last = lint.diagnostics[lint.diagnostics.length - 1];
  assert.equal(last.code, 'UNASSIGNED_MORE');
  assert.match(last.message, /4 more/);
});

test('validateRom flags SYS machine calls as informational', () => {
  const lint = Chip8.validateRom([0x0A, 0xBC]);
  assert.equal(lint.diagnostics[0].code, 'SYS_USED');
  assert.equal(lint.diagnostics[0].severity, 'info');
});

test('validateRom warns on control flow below the program area', () => {
  for (const word of [[0x10, 0x50], [0x21, 0xFF]]) {
    const lint = Chip8.validateRom(word);
    assert.equal(lint.diagnostics[0].code, 'JUMP_LOW_MEM');
    assert.equal(lint.diagnostics[0].severity, 'warning');
  }
});

test('validateRom warns on control flow past the end of the cartridge', () => {
  const lint = Chip8.validateRom([0x12, 0x34]);
  assert.equal(lint.diagnostics[0].code, 'JUMP_BEYOND_ROM');
  assert.equal(lint.diagnostics[0].offset, 0x200);
});

test('validateRom flags zero height sprite draws', () => {
  const lint = Chip8.validateRom([0xD0, 0x10]);
  assert.equal(lint.diagnostics[0].code, 'DRW_ZERO_HEIGHT');
});

test('validateRom rejects non byte values and non arrays as errors', () => {
  for (const rom of [[256], [-1], [1.5], null, { length: 2 }]) {
    const lint = Chip8.validateRom(rom);
    assert.equal(lint.ok, false, JSON.stringify(rom));
    assert.ok(lint.errors >= 1);
  }
});

test('validateRom rejects empty and oversized cartridges', () => {
  assert.equal(Chip8.validateRom([]).diagnostics[0].code, 'EMPTY_ROM');
  assert.equal(Chip8.validateRom(new Uint8Array(3585)).diagnostics[0].code, 'OVERSIZE_ROM');
});

test('validateRom accepts a string ROM like the loader does', () => {
  const lint = Chip8.validateRom('\x00\xE0');
  assert.equal(lint.ok, true);
  assert.equal(lint.diagnostics.length, 0);
});

test('every shipped cartridge passes lint without errors', () => {
  for (const rom of roms) {
    const lint = Chip8.validateRom(rom.bytes);
    assert.equal(lint.ok, true, rom.name);
    assert.equal(lint.errors, 0, rom.name);
  }
});
