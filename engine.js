/*
 * Chipper-8: CHIP-8 CPU interpreter core.
 *
 * Zero dependencies. Works in the browser (exposes window.Chipper8) and in
 * Node.js (exports the Chip8 class via module.exports) so the exact same code
 * can be unit tested with `node --test`.
 *
 * Memory map:
 *   0x000 - 0x1FF  interpreter area (font sprites live at 0x000)
 *   0x200 - 0xFFF  program / ROM space
 *
 * Display: 64 x 32 monochrome framebuffer, stored row-major in `display`.
 * Timers (delay and sound) count down at 60 Hz and live as plain numbers.
 */
(function (root, factory) {
  'use strict';
  var Chip8 = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = Chip8;
  } else {
    root.Chipper8 = root.Chipper8 || {};
    root.Chipper8.Chip8 = Chip8;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 16 built-in hex font sprites, 5 bytes each (0x0 through 0xF).
  var FONTSET = [
    0xF0, 0x90, 0x90, 0x90, 0xF0, // 0
    0x20, 0x60, 0x20, 0x20, 0x70, // 1
    0xF0, 0x10, 0xF0, 0x80, 0xF0, // 2
    0xF0, 0x10, 0xF0, 0x10, 0xF0, // 3
    0x90, 0x90, 0xF0, 0x10, 0x10, // 4
    0xF0, 0x80, 0xF0, 0x10, 0xF0, // 5
    0xF0, 0x80, 0xF0, 0x90, 0xF0, // 6
    0xF0, 0x10, 0x20, 0x40, 0x40, // 7
    0xF0, 0x90, 0xF0, 0x90, 0xF0, // 8
    0xF0, 0x90, 0xF0, 0x10, 0xF0, // 9
    0xF0, 0x90, 0xF0, 0x90, 0x90, // A
    0xE0, 0x90, 0xE0, 0x90, 0xE0, // B
    0xF0, 0x80, 0x80, 0x80, 0xF0, // C
    0xE0, 0x90, 0x90, 0x90, 0xE0, // D
    0xF0, 0x80, 0xF0, 0x80, 0xF0, // E
    0xF0, 0x80, 0xF0, 0x80, 0x80  // F
  ];

  var MEMORY_SIZE = 4096;
  var PROGRAM_START = 0x200;
  var DISPLAY_WIDTH = 64;
  var DISPLAY_HEIGHT = 32;
  var NUM_REGISTERS = 16;
  var STACK_SIZE = 16;

  function Chip8() {
    // Allow callers to supply a deterministic random source for testing.
    // Must return a float in [0, 1). Defaults to Math.random.
    this.rng = Math.random;
    // When true, FX55 / FX65 do not advance the I register (modern quirk).
    // Defaults to false, matching the original COSMAC VIP interpreter.
    this.quirks = { loadStoreNoIncrementI: false, shiftUsesVy: false, jumpUsesVx: false };
    this.reset();
  }

  Chip8.prototype.reset = function () {
    this.memory = new Uint8Array(MEMORY_SIZE);
    this.V = new Uint8Array(NUM_REGISTERS);
    this.display = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT);
    this.stack = new Uint16Array(STACK_SIZE);
    this.keys = new Uint8Array(NUM_REGISTERS);

    this.I = 0;
    this.pc = PROGRAM_START;
    this.sp = 0;
    this.delayTimer = 0;
    this.soundTimer = 0;

    this.drawFlag = false;
    this.halted = false;
    this.lastOpcode = 0;

    for (var i = 0; i < FONTSET.length; i++) {
      this.memory[i] = FONTSET[i];
    }
    return this;
  };

  // Load a ROM (array of bytes, Uint8Array, or plain number array) at 0x200.
  Chip8.prototype.load = function (rom) {
    var bytes = rom;
    if (typeof rom === 'string') {
      bytes = [];
      for (var s = 0; s < rom.length; s++) { bytes.push(rom.charCodeAt(s) & 0xFF); }
    }
    var end = Math.min(bytes.length, MEMORY_SIZE - PROGRAM_START);
    for (var i = 0; i < end; i++) {
      this.memory[PROGRAM_START + i] = bytes[i] & 0xFF;
    }
    this.pc = PROGRAM_START;
    this.halted = false;
    return this;
  };

  Chip8.prototype.clearDisplay = function () {
    this.display.fill(0);
    this.drawFlag = true;
  };

  Chip8.prototype.getPixel = function (x, y) {
    return this.display[y * DISPLAY_WIDTH + x];
  };

  Chip8.prototype.setKey = function (key, down) {
    if (key >= 0 && key < NUM_REGISTERS) {
      this.keys[key] = down ? 1 : 0;
    }
  };

  // Decrement the 60 Hz timers. Call once per frame from the host loop.
  Chip8.prototype.tickTimers = function () {
    if (this.delayTimer > 0) { this.delayTimer -= 1; }
    if (this.soundTimer > 0) { this.soundTimer -= 1; }
    return this;
  };

  // Convert a number to a fixed width hex string.
  function hex(value, width) {
    var s = value.toString(16).toUpperCase();
    while (s.length < width) { s = '0' + s; }
    return '0x' + s;
  }

  // Human readable disassembly of a single opcode, used by the live inspector.
  Chip8.prototype.disassemble = function (opcode) {
    var a = opcode & 0xFFFF;
    var family = (a & 0xF000) >> 12;
    var x = (a & 0x0F00) >> 8;
    var y = (a & 0x00F0) >> 4;
    var n = a & 0x000F;
    var kk = a & 0x00FF;
    var nnn = a & 0x0FFF;
    switch (family) {
      case 0x0:
        if (a === 0x00E0) { return 'CLS'; }
        if (a === 0x00EE) { return 'RET'; }
        return 'SYS ' + hex(nnn, 3);
      case 0x1: return 'JP ' + hex(nnn, 3);
      case 0x2: return 'CALL ' + hex(nnn, 3);
      case 0x3: return 'SE V' + x.toString(16).toUpperCase() + ', ' + hex(kk, 2);
      case 0x4: return 'SNE V' + x.toString(16).toUpperCase() + ', ' + hex(kk, 2);
      case 0x5: return 'SE V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
      case 0x6: return 'LD V' + x.toString(16).toUpperCase() + ', ' + hex(kk, 2);
      case 0x7: return 'ADD V' + x.toString(16).toUpperCase() + ', ' + hex(kk, 2);
      case 0x8:
        switch (n) {
          case 0x0: return 'LD V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0x1: return 'OR V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0x2: return 'AND V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0x3: return 'XOR V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0x4: return 'ADD V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0x5: return 'SUB V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0x6: return 'SHR V' + x.toString(16).toUpperCase();
          case 0x7: return 'SUBN V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0xE: return 'SHL V' + x.toString(16).toUpperCase();
          default: return 'DW ' + hex(a, 4);
        }
      case 0x9: return 'SNE V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
      case 0xA: return 'LD I, ' + hex(nnn, 3);
      case 0xB: return 'JP V0, ' + hex(nnn, 3);
      case 0xC: return 'RND V' + x.toString(16).toUpperCase() + ', ' + hex(kk, 2);
      case 0xD: return 'DRW V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase() + ', ' + n;
      case 0xE:
        if (kk === 0x9E) { return 'SKP V' + x.toString(16).toUpperCase(); }
        if (kk === 0xA1) { return 'SKNP V' + x.toString(16).toUpperCase(); }
        return 'DW ' + hex(a, 4);
      case 0xF:
        switch (kk) {
          case 0x07: return 'LD V' + x.toString(16).toUpperCase() + ', DT';
          case 0x0A: return 'LD V' + x.toString(16).toUpperCase() + ', K';
          case 0x15: return 'LD DT, V' + x.toString(16).toUpperCase();
          case 0x18: return 'LD ST, V' + x.toString(16).toUpperCase();
          case 0x1E: return 'ADD I, V' + x.toString(16).toUpperCase();
          case 0x29: return 'LD F, V' + x.toString(16).toUpperCase();
          case 0x33: return 'LD B, V' + x.toString(16).toUpperCase();
          case 0x55: return 'LD [I], V' + x.toString(16).toUpperCase();
          case 0x65: return 'LD V' + x.toString(16).toUpperCase() + ', [I]';
          default: return 'DW ' + hex(a, 4);
        }
      default: return 'DW ' + hex(a, 4);
    }
  };

  // Fetch, decode and execute a single instruction.
  // Returns the raw opcode that was executed (or 0 if the CPU was halted).
  Chip8.prototype.step = function () {
    if (this.halted) { return this.lastOpcode; }

    var opcode = (this.memory[this.pc] << 8) | this.memory[this.pc + 1];
    this.lastOpcode = opcode;
    this.pc = (this.pc + 2) & 0xFFFF;

    var family = (opcode & 0xF000) >> 12;
    var x = (opcode & 0x0F00) >> 8;
    var y = (opcode & 0x00F0) >> 4;
    var n = opcode & 0x000F;
    var kk = opcode & 0x00FF;
    var nnn = opcode & 0x0FFF;
    var i, sum, pixel, spriteByte, bit, px, py, idx, key, found;

    switch (family) {
      case 0x0:
        if (opcode === 0x00E0) {
          // 00E0 - CLS: clear the display.
          this.clearDisplay();
        } else if (opcode === 0x00EE) {
          // 00EE - RET: return from subroutine.
          this.sp -= 1;
          if (this.sp < 0) { this.sp = 0; }
          this.pc = this.stack[this.sp];
        } else {
          // 0NNN - SYS: ignored on modern interpreters (no machine code call).
        }
        break;

      case 0x1:
        // 1NNN - JP addr.
        this.pc = nnn;
        break;

      case 0x2:
        // 2NNN - CALL addr.
        this.stack[this.sp] = this.pc;
        this.sp = (this.sp + 1) % STACK_SIZE;
        this.pc = nnn;
        break;

      case 0x3:
        // 3XKK - SE Vx, byte: skip if equal.
        if (this.V[x] === kk) { this.pc = (this.pc + 2) & 0xFFFF; }
        break;

      case 0x4:
        // 4XKK - SNE Vx, byte: skip if not equal.
        if (this.V[x] !== kk) { this.pc = (this.pc + 2) & 0xFFFF; }
        break;

      case 0x5:
        // 5XY0 - SE Vx, Vy: skip if registers equal.
        if (n === 0 && this.V[x] === this.V[y]) { this.pc = (this.pc + 2) & 0xFFFF; }
        break;

      case 0x6:
        // 6XKK - LD Vx, byte.
        this.V[x] = kk;
        break;

      case 0x7:
        // 7XKK - ADD Vx, byte (no carry flag change).
        this.V[x] = (this.V[x] + kk) & 0xFF;
        break;

      case 0x8:
        switch (n) {
          case 0x0: // 8XY0 - LD Vx, Vy
            this.V[x] = this.V[y];
            break;
          case 0x1: // 8XY1 - OR Vx, Vy
            this.V[x] = this.V[x] | this.V[y];
            break;
          case 0x2: // 8XY2 - AND Vx, Vy
            this.V[x] = this.V[x] & this.V[y];
            break;
          case 0x3: // 8XY3 - XOR Vx, Vy
            this.V[x] = this.V[x] ^ this.V[y];
            break;
          case 0x4: // 8XY4 - ADD Vx, Vy with carry in VF
            sum = this.V[x] + this.V[y];
            this.V[0xF] = sum > 0xFF ? 1 : 0;
            this.V[x] = sum & 0xFF;
            break;
          case 0x5: // 8XY5 - SUB Vx, Vy. VF = NOT borrow.
            this.V[0xF] = this.V[x] >= this.V[y] ? 1 : 0;
            this.V[x] = (this.V[x] - this.V[y]) & 0xFF;
            break;
          case 0x6: // 8XY6 - SHR Vx. VF = least significant bit before shift.
            if (this.quirks.shiftUsesVy) { this.V[x] = this.V[y]; }
            this.V[0xF] = this.V[x] & 0x1;
            this.V[x] = (this.V[x] >> 1) & 0xFF;
            break;
          case 0x7: // 8XY7 - SUBN Vx, Vy. VF = NOT borrow.
            this.V[0xF] = this.V[y] >= this.V[x] ? 1 : 0;
            this.V[x] = (this.V[y] - this.V[x]) & 0xFF;
            break;
          case 0xE: // 8XYE - SHL Vx. VF = most significant bit before shift.
            if (this.quirks.shiftUsesVy) { this.V[x] = this.V[y]; }
            this.V[0xF] = (this.V[x] & 0x80) ? 1 : 0;
            this.V[x] = (this.V[x] << 1) & 0xFF;
            break;
          default:
            this.halted = true;
            break;
        }
        break;

      case 0x9:
        // 9XY0 - SNE Vx, Vy: skip if registers not equal.
        if (n === 0 && this.V[x] !== this.V[y]) { this.pc = (this.pc + 2) & 0xFFFF; }
        break;

      case 0xA:
        // ANNN - LD I, addr.
        this.I = nnn;
        break;

      case 0xB:
        // BNNN - JP V0, addr (or Vx + addr under the jumpUsesVx quirk).
        this.pc = (nnn + (this.quirks.jumpUsesVx ? this.V[x] : this.V[0])) & 0xFFFF;
        break;

      case 0xC:
        // CXKK - RND Vx, byte.
        this.V[x] = Math.floor(this.rng() * 256) & kk;
        break;

      case 0xD: {
        // DXYN - DRW Vx, Vy, nibble. XOR sprite into framebuffer, wrap coordinates,
        // and set VF when any lit pixel is toggled off (collision).
        this.V[0xF] = 0;
        var startX = this.V[x] % DISPLAY_WIDTH;
        var startY = this.V[y] % DISPLAY_HEIGHT;
        for (var row = 0; row < n; row++) {
          spriteByte = this.memory[(this.I + row) & 0xFFF];
          for (var col = 0; col < 8; col++) {
            bit = (spriteByte >> (7 - col)) & 0x1;
            if (bit === 0) { continue; }
            px = (startX + col) % DISPLAY_WIDTH;
            py = (startY + row) % DISPLAY_HEIGHT;
            idx = py * DISPLAY_WIDTH + px;
            if (this.display[idx] === 1) { this.V[0xF] = 1; }
            this.display[idx] ^= 1;
          }
        }
        this.drawFlag = true;
        break;
      }

      case 0xE:
        if (kk === 0x9E) {
          // EX9E - SKP Vx: skip if key in Vx is down.
          if (this.keys[this.V[x] & 0xF] === 1) { this.pc = (this.pc + 2) & 0xFFFF; }
        } else if (kk === 0xA1) {
          // EXA1 - SKNP Vx: skip if key in Vx is not down.
          if (this.keys[this.V[x] & 0xF] !== 1) { this.pc = (this.pc + 2) & 0xFFFF; }
        } else {
          this.halted = true;
        }
        break;

      case 0xF:
        switch (kk) {
          case 0x07: // FX07 - LD Vx, DT
            this.V[x] = this.delayTimer & 0xFF;
            break;
          case 0x0A: { // FX0A - LD Vx, K: wait for a key press.
            found = -1;
            for (key = 0; key < NUM_REGISTERS; key++) {
              if (this.keys[key] === 1) { found = key; break; }
            }
            if (found === -1) {
              // Rewind so this instruction is re-executed next step.
              this.pc = (this.pc - 2) & 0xFFFF;
            } else {
              this.V[x] = found;
            }
            break;
          }
          case 0x15: // FX15 - LD DT, Vx
            this.delayTimer = this.V[x];
            break;
          case 0x18: // FX18 - LD ST, Vx
            this.soundTimer = this.V[x];
            break;
          case 0x1E: // FX1E - ADD I, Vx
            this.I = (this.I + this.V[x]) & 0xFFFF;
            break;
          case 0x29: // FX29 - LD F, Vx: address of font sprite for the digit in Vx.
            this.I = (this.V[x] & 0xF) * 5;
            break;
          case 0x33: // FX33 - LD B, Vx: store BCD representation at I, I+1, I+2.
            this.memory[this.I & 0xFFF] = Math.floor(this.V[x] / 100) % 10;
            this.memory[(this.I + 1) & 0xFFF] = Math.floor(this.V[x] / 10) % 10;
            this.memory[(this.I + 2) & 0xFFF] = this.V[x] % 10;
            break;
          case 0x55: // FX55 - LD [I], V0..Vx
            for (i = 0; i <= x; i++) {
              this.memory[(this.I + i) & 0xFFF] = this.V[i];
            }
            if (!this.quirks.loadStoreNoIncrementI) { this.I = (this.I + x + 1) & 0xFFFF; }
            break;
          case 0x65: // FX65 - LD V0..Vx, [I]
            for (i = 0; i <= x; i++) {
              this.V[i] = this.memory[(this.I + i) & 0xFFF];
            }
            if (!this.quirks.loadStoreNoIncrementI) { this.I = (this.I + x + 1) & 0xFFFF; }
            break;
          default:
            this.halted = true;
            break;
        }
        break;

      default:
        this.halted = true;
        break;
    }

    return opcode;
  };

  Chip8.FONTSET = FONTSET;
  Chip8.MEMORY_SIZE = MEMORY_SIZE;
  Chip8.PROGRAM_START = PROGRAM_START;
  Chip8.DISPLAY_WIDTH = DISPLAY_WIDTH;
  Chip8.DISPLAY_HEIGHT = DISPLAY_HEIGHT;
  Chip8.hex = hex;

  return Chip8;
}));
