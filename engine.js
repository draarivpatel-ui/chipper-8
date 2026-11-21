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
    this.quirks = { loadStoreNoIncrementI: false, shiftUsesVy: false, jumpUsesVx: false, logicResetsVf: false, clipSprites: false, waitForRelease: false };
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
    this.error = null;
    this.waitingForKey = null;
    this.waitKey = null;
    this.releasedKey = null;
    this.instructionsExecuted = 0;
    this.lastFetchPc = 0;
    this.diagnostics = [];
    this.diagnosticCounts = Object.create(null);
    // 60 Hz schedule position: CPU cycle edges elapsed since the last timer
    // tick. step() advances it and tickTimers() parks it at -1 so the
    // coincident edge's increment lands back on zero, matching the canonical
    // tick-before-instruction order shared with Clock.advance. It is
    // canonical state: snapshots serialize it and the hash covers it, so a
    // restored machine resumes the identical timer phase. reset() restarts
    // the schedule exactly like resetMachine() restarts the clock.
    this.traceCyclePhase = 0;
    // Transient run control, never canonical state: trace() sets it around a
    // frozen run so step() skips the 60 Hz edge accounting, then restores the
    // previous value. It stays out of snapshots and hashes.
    this.traceTimersFrozen = false;

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
    if (!bytes || !Number.isInteger(bytes.length) || bytes.length < 1 || bytes.length > MEMORY_SIZE - PROGRAM_START) {
      throw new RangeError('ROM must contain 1 to 3584 bytes.');
    }
    for (var check = 0; check < bytes.length; check++) {
      if (!Number.isInteger(bytes[check]) || bytes[check] < 0 || bytes[check] > 255) throw new RangeError('ROM values must be bytes.');
    }
    this.reset();
    for (var i = 0; i < bytes.length; i++) this.memory[PROGRAM_START + i] = bytes[i];
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
    if (Number.isInteger(key) && key >= 0 && key < NUM_REGISTERS) {
      if (this.waitingForKey !== null && this.quirks.waitForRelease) {
        if (down && !this.keys[key] && this.waitKey === null) this.waitKey = key;
        if (!down && this.keys[key] && this.waitKey === key) this.releasedKey = key;
      }
      this.keys[key] = down ? 1 : 0;
    }
  };

  // Decrement the 60 Hz timers. Call once per frame from the host loop.
  Chip8.prototype.tickTimers = function () {
    if (this.delayTimer > 0) { this.delayTimer -= 1; }
    if (this.soundTimer > 0) { this.soundTimer -= 1; }
    // Park the cycle phase at -1: the CPU edge coinciding with this timer
    // edge resolves the tick first, and its step() increment lands the
    // phase back on 0, exactly like the canonical schedule in Clock.advance.
    this.traceCyclePhase = -1;
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
      case 0x5: return n === 0 ? 'SE V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase() : 'DW ' + hex(a, 4);
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
          case 0x6: return 'SHR V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0x7: return 'SUBN V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          case 0xE: return 'SHL V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase();
          default: return 'DW ' + hex(a, 4);
        }
      case 0x9: return n === 0 ? 'SNE V' + x.toString(16).toUpperCase() + ', V' + y.toString(16).toUpperCase() : 'DW ' + hex(a, 4);
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

  // Quirk-aware disassembly for live and exported traces. `disassemble()`
  // stays a neutral round-trip spelling for the assembler; this variant
  // reports the effective register and resolved target of the active quirk
  // set. Currently that only affects BNNN: under jumpUsesVx (CHIP-48) the
  // offset register is Vx, so `JP V2, 0x234 -> 0x23F` shows what the CPU
  // actually executes instead of the neutral `JP V0, 0x234`.
  Chip8.prototype.disassembleEffective = function (opcode) {
    var a = opcode & 0xFFFF;
    if ((a & 0xF000) === 0xB000) {
      var x = (a & 0x0F00) >> 8;
      var nnn = a & 0x0FFF;
      var regIndex = this.quirks.jumpUsesVx ? x : 0;
      var target = (nnn + this.V[regIndex]) & 0xFFF;
      return 'JP V' + regIndex.toString(16).toUpperCase() + ', ' + hex(nnn, 3) + ' -> ' + hex(target, 3);
    }
    return this.disassemble(opcode);
  };

  // Fetch, decode and execute a single instruction.
  // Returns the raw opcode that was executed (or 0 if the CPU was halted).
  Chip8.prototype.step = function () {
    if (this.halted) { return this.lastOpcode; }
    // Every non-halted step is one CPU cycle edge on the 60 Hz schedule.
    // tickTimers() parks the phase at -1 so a coincident edge's increment
    // lands back on 0; stalled FX0A fetches and faults still consume edges.
    // Steps inside a frozen trace are the exception: they execute without
    // moving the timer schedule, so the flag suppresses the increment.
    if (!this.traceTimersFrozen) { this.traceCyclePhase += 1; }

    if (!Number.isInteger(this.pc) || this.pc < 0 || this.pc >= MEMORY_SIZE - 1) { this.fault('Program counter is outside executable memory.', 'PC_RANGE'); return this.lastOpcode; }
    var fetchPc = this.pc;
    this.lastFetchPc = fetchPc;
    if (fetchPc < PROGRAM_START) { this.note('LOW_MEM_FETCH', 'Fetched an instruction below 0x200 inside the interpreter area.', 'warning'); }
    var opcode = (this.memory[this.pc] << 8) | this.memory[this.pc + 1];
    this.lastOpcode = opcode;
    this.instructionsExecuted++;
    this.pc = (this.pc + 2) & 0xFFFF;

    var family = (opcode & 0xF000) >> 12;
    var x = (opcode & 0x0F00) >> 8;
    var y = (opcode & 0x00F0) >> 4;
    var n = opcode & 0x000F;
    var kk = opcode & 0x00FF;
    var nnn = opcode & 0x0FFF;
    var i, sum, pixel, spriteByte, bit, px, py, idx, key, found;
    var vx = this.V[x], vy = this.V[y];

    switch (family) {
      case 0x0:
        if (opcode === 0x00E0) {
          // 00E0 - CLS: clear the display.
          this.clearDisplay();
        } else if (opcode === 0x00EE) {
          // 00EE - RET: return from subroutine.
          if (this.sp === 0) { this.fault('Return stack underflow.', 'STACK_UNDERFLOW'); break; }
          this.sp -= 1;
          this.pc = this.stack[this.sp];
        } else {
          // 0NNN - SYS: ignored on modern interpreters (no machine code call).
          this.note('SYS_NOP', 'SYS ' + hex(nnn, 3) + ' ignored: machine calls are no-ops on this interpreter.');
        }
        break;

      case 0x1:
        // 1NNN - JP addr.
        this.pc = nnn;
        break;

      case 0x2:
        // 2NNN - CALL addr.
        if (this.sp >= STACK_SIZE) { this.fault('Call stack overflow.', 'STACK_OVERFLOW'); break; }
        this.stack[this.sp] = this.pc;
        this.sp++;
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
        if (n !== 0) { this.fault('Invalid register skip opcode.', 'BAD_OPCODE'); break; }
        if (this.V[x] === this.V[y]) { this.pc = (this.pc + 2) & 0xFFFF; }
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
            this.V[x] = vx | vy;
            if (this.quirks.logicResetsVf) this.V[0xF] = 0;
            break;
          case 0x2: // 8XY2 - AND Vx, Vy
            this.V[x] = vx & vy;
            if (this.quirks.logicResetsVf) this.V[0xF] = 0;
            break;
          case 0x3: // 8XY3 - XOR Vx, Vy
            this.V[x] = vx ^ vy;
            if (this.quirks.logicResetsVf) this.V[0xF] = 0;
            break;
          case 0x4: // 8XY4 - ADD Vx, Vy with carry in VF
            sum = vx + vy;
            this.V[x] = sum & 0xFF;
            this.V[0xF] = sum > 0xFF ? 1 : 0;
            break;
          case 0x5: // 8XY5 - SUB Vx, Vy. VF = NOT borrow.
            this.V[x] = (vx - vy) & 0xFF;
            this.V[0xF] = vx >= vy ? 1 : 0;
            break;
          case 0x6: // 8XY6 - SHR Vx. VF = least significant bit before shift.
            var rightValue = this.quirks.shiftUsesVy ? vy : vx;
            this.V[x] = rightValue >> 1;
            this.V[0xF] = rightValue & 1;
            break;
          case 0x7: // 8XY7 - SUBN Vx, Vy. VF = NOT borrow.
            this.V[x] = (vy - vx) & 0xFF;
            this.V[0xF] = vy >= vx ? 1 : 0;
            break;
          case 0xE: // 8XYE - SHL Vx. VF = most significant bit before shift.
            var leftValue = this.quirks.shiftUsesVy ? vy : vx;
            this.V[x] = (leftValue << 1) & 0xFF;
            this.V[0xF] = leftValue >> 7;
            break;
          default:
            this.fault('Unknown opcode ' + hex(opcode, 4) + '.', 'BAD_OPCODE');
            break;
        }
        break;

      case 0x9:
        // 9XY0 - SNE Vx, Vy: skip if registers not equal.
        if (n !== 0) { this.fault('Invalid register skip opcode.', 'BAD_OPCODE'); break; }
        if (this.V[x] !== this.V[y]) { this.pc = (this.pc + 2) & 0xFFFF; }
        break;

      case 0xA:
        // ANNN - LD I, addr.
        this.I = nnn;
        break;

      case 0xB:
        // BNNN - JP V0, addr (or Vx + addr under the jumpUsesVx quirk).
        // The COSMAC VIP PC is 12 bits, so the target wraps at 0xFFF.
        var jumpOffset = this.quirks.jumpUsesVx ? this.V[x] : this.V[0];
        if (nnn + jumpOffset > 0xFFF) { this.note('PC_WRAP', 'Offset jump wrapped the program counter past 0xFFF.'); }
        this.pc = (nnn + jumpOffset) & 0xFFF;
        break;

      case 0xC:
        // CXKK - RND Vx, byte.
        this.V[x] = Math.floor(this.rng() * 256) & kk;
        break;

      case 0xD: {
        // DXYN - DRW Vx, Vy, nibble. XOR sprite into framebuffer, wrap coordinates,
        // and set VF when any lit pixel is toggled off (collision).
        this.V[0xF] = 0;
        var startX = vx % DISPLAY_WIDTH;
        var startY = vy % DISPLAY_HEIGHT;
        var clipped = 0, wrapped = 0;
        if (n === 0) { this.note('DRW_ZERO_HEIGHT', 'DRW with height 0 draws nothing on this interpreter.'); }
        for (var row = 0; row < n; row++) {
          spriteByte = this.memory[(this.I + row) & 0xFFF];
          for (var col = 0; col < 8; col++) {
            bit = (spriteByte >> (7 - col)) & 0x1;
            if (bit === 0) { continue; }
            var offScreen = startX + col >= DISPLAY_WIDTH || startY + row >= DISPLAY_HEIGHT;
            if (this.quirks.clipSprites && offScreen) { clipped++; continue; }
            if (offScreen) { wrapped++; }
            px = (startX + col) % DISPLAY_WIDTH;
            py = (startY + row) % DISPLAY_HEIGHT;
            idx = py * DISPLAY_WIDTH + px;
            if (this.display[idx] === 1) { this.V[0xF] = 1; }
            this.display[idx] ^= 1;
          }
        }
        if (clipped > 0) { this.note('SPRITE_CLIPPED', 'Clipped ' + clipped + ' sprite pixel' + (clipped === 1 ? '' : 's') + ' at the screen edge.'); }
        if (wrapped > 0) { this.note('SPRITE_WRAPPED', 'Wrapped ' + wrapped + ' sprite pixel' + (wrapped === 1 ? '' : 's') + ' around the screen edge.'); }
        this.drawFlag = true;
        break;
      }

      case 0xE:
        if (kk === 0x9E) {
          // EX9E - SKP Vx: skip if key in Vx is down.
          if (this.V[x] > 0xF) { this.note('KEY_MASKED', 'Key index ' + this.V[x] + ' masked to ' + (this.V[x] & 0xF) + ' for SKP.'); }
          if (this.keys[this.V[x] & 0xF] === 1) { this.pc = (this.pc + 2) & 0xFFFF; }
        } else if (kk === 0xA1) {
          // EXA1 - SKNP Vx: skip if key in Vx is not down.
          if (this.V[x] > 0xF) { this.note('KEY_MASKED', 'Key index ' + this.V[x] + ' masked to ' + (this.V[x] & 0xF) + ' for SKNP.'); }
          if (this.keys[this.V[x] & 0xF] !== 1) { this.pc = (this.pc + 2) & 0xFFFF; }
        } else {
          this.fault('Unknown opcode ' + hex(opcode, 4) + '.', 'BAD_OPCODE');
        }
        break;

      case 0xF:
        switch (kk) {
          case 0x07: // FX07 - LD Vx, DT
            this.V[x] = this.delayTimer & 0xFF;
            break;
          case 0x0A: {
            found = -1;
            if (this.quirks.waitForRelease) {
              if (this.waitingForKey === null) { this.waitingForKey = x; this.waitKey = null; this.releasedKey = null; }
              if (this.releasedKey !== null) found = this.releasedKey;
            } else {
              this.waitingForKey = x;
              for (key = 0; key < NUM_REGISTERS; key++) if (this.keys[key] === 1) { found = key; break; }
            }
            if (found === -1) {
              this.pc = (this.pc - 2) & 0xFFF; this.instructionsExecuted--;
            } else {
              this.V[x] = found;
              this.waitingForKey = null; this.waitKey = null; this.releasedKey = null;
            }
            break;
          }
          case 0x15: // FX15 - LD DT, Vx
            this.delayTimer = this.V[x];
            break;
          case 0x18: // FX18 - LD ST, Vx
            this.soundTimer = this.V[x];
            break;
          case 0x1E: // FX1E - ADD I, Vx. I is 12 bits on the COSMAC VIP.
            if (this.I + this.V[x] > 0xFFF) { this.note('I_WRAP', 'ADD I, Vx wrapped the index register past 0xFFF.'); }
            this.I = (this.I + this.V[x]) & 0xFFF;
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
            if (this.I + x > 0xFFF) { this.note('MEM_WRAP', 'Register store wrapped past the end of RAM at 0xFFF.'); }
            for (i = 0; i <= x; i++) {
              this.memory[(this.I + i) & 0xFFF] = this.V[i];
            }
            if (!this.quirks.loadStoreNoIncrementI) { this.I = (this.I + x + 1) & 0xFFF; }
            break;
          case 0x65: // FX65 - LD V0..Vx, [I]
            if (this.I + x > 0xFFF) { this.note('MEM_WRAP', 'Register load wrapped past the end of RAM at 0xFFF.'); }
            for (i = 0; i <= x; i++) {
              this.V[i] = this.memory[(this.I + i) & 0xFFF];
            }
            if (!this.quirks.loadStoreNoIncrementI) { this.I = (this.I + x + 1) & 0xFFF; }
            break;
          default:
            this.fault('Unknown opcode ' + hex(opcode, 4) + '.', 'BAD_OPCODE');
            break;
        }
        break;

      default:
        this.fault('Unknown opcode ' + hex(opcode, 4) + '.', 'BAD_OPCODE');
        break;
    }

    return opcode;
  };

  // Record a bounded diagnostic event. Counts per code keep accumulating even
  // after the visible log reaches MAX_DIAGNOSTICS, so rare events are not lost.
  Chip8.prototype.note = function (code, message, severity) {
    this.diagnosticCounts[code] = (this.diagnosticCounts[code] || 0) + 1;
    if (this.diagnostics.length < Chip8.MAX_DIAGNOSTICS) {
      this.diagnostics.push({
        cycle: this.instructionsExecuted,
        pc: this.lastFetchPc,
        code: code,
        severity: severity || 'info',
        message: message
      });
    }
  };

  Chip8.prototype.fault = function (message, code) {
    this.halted = true; this.error = message; this.soundTimer = 0;
    this.note(code || 'FAULT', message, 'error');
  };
  Chip8.MAX_DIAGNOSTICS = 128;
  Chip8.PROFILES = Object.freeze({
    modern: Object.freeze({ loadStoreNoIncrementI: false, shiftUsesVy: false, jumpUsesVx: false, logicResetsVf: false, clipSprites: false, waitForRelease: false }),
    vip: Object.freeze({ loadStoreNoIncrementI: false, shiftUsesVy: true, jumpUsesVx: false, logicResetsVf: true, clipSprites: true, waitForRelease: true }),
    chip48: Object.freeze({ loadStoreNoIncrementI: true, shiftUsesVy: false, jumpUsesVx: true, logicResetsVf: false, clipSprites: true, waitForRelease: false })
  });
  Chip8.prototype.setProfile = function (name) {
    if (!Object.prototype.hasOwnProperty.call(Chip8.PROFILES, name)) throw new RangeError('Unknown interpreter profile.');
    this.quirks = Object.assign({}, Chip8.PROFILES[name]);
    this.waitingForKey = null; this.waitKey = null; this.releasedKey = null;
    return this;
  };

  // ------------------------------------------------------------------
  // Determinism, snapshots, traces and ROM diagnostics.
  //
  // seededRng: mulberry32, a tiny deterministic PRNG. Feeding the same seed
  // into a fresh machine reproduces an identical CXKK stream, which makes
  // traces and state hashes reproducible run over run. The generator keeps
  // its cursor on the function object itself (`rngState`, `rngKind`,
  // `rngSeed`) so snapshots can serialize the exact position in the stream
  // and restoreState() can resume it deterministically.
  Chip8.seededRng = function (seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) {
      throw new RangeError('Seed must be a 32-bit unsigned integer.');
    }
    var rng = function () {
      rng.rngState = (rng.rngState + 0x6D2B79F5) >>> 0;
      var t = rng.rngState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.rngKind = 'mulberry32';
    rng.rngSeed = seed >>> 0;
    rng.rngState = seed >>> 0;
    return rng;
  };

  // Describe the live RNG in a serializable form. Custom generators (for
  // example Math.random or a test stub) carry no serializable cursor and are
  // marked explicitly so a snapshot never pretends it can resume them.
  function rngDescriptor(rng) {
    if (rng && typeof rng.rngKind === 'string' && rng.rngKind !== 'custom-unserializable' &&
        Number.isInteger(rng.rngState) && rng.rngState >= 0 && rng.rngState <= 0xFFFFFFFF) {
      return { kind: rng.rngKind, state: rng.rngState >>> 0 };
    }
    return { kind: 'custom-unserializable', state: -1 };
  }

  // fnv1a: FNV-1a 32-bit hash over UTF-16 code units. The canonical state
  // string is plain ASCII, so the digest is stable across engines.
  function fnv1a(text) {
    var h = 0x811C9DC5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function hexByte(v) {
    var s = (v & 0xFF).toString(16);
    return s.length === 1 ? '0' + s : s;
  }
  function packBytes(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i++) { s += hexByte(arr[i]); }
    return s;
  }
  function packWords(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i++) {
      var h = (arr[i] & 0xFFFF).toString(16);
      s += '000'.slice(h.length - 1) + h;
    }
    return s;
  }
  // Pack VRAM bits MSB-first, eight pixels per byte (2048 px -> 512 hex chars).
  function packBits(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) { b = (b << 1) | (arr[i + j] ? 1 : 0); }
      s += hexByte(b);
    }
    return s;
  }
  function unpackHex(str, len, field) {
    if (typeof str !== 'string' || str.length !== len * 2 || !/^[0-9a-f]+$/i.test(str)) {
      throw new RangeError('Snapshot field ' + field + ' is corrupt.');
    }
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) { out[i] = parseInt(str.substr(i * 2, 2), 16); }
    return out;
  }
  function unpackBits(str, len) {
    var bytes = unpackHex(str, (len + 7) >> 3, 'vram');
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) { out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1; }
    return out;
  }

  function quirkFlags(q) {
    return {
      loadStoreNoIncrementI: !!q.loadStoreNoIncrementI,
      shiftUsesVy: !!q.shiftUsesVy,
      jumpUsesVx: !!q.jumpUsesVx,
      logicResetsVf: !!q.logicResetsVf,
      clipSprites: !!q.clipSprites,
      waitForRelease: !!q.waitForRelease
    };
  }
  var QUIRK_KEYS = ['loadStoreNoIncrementI', 'shiftUsesVy', 'jumpUsesVx', 'logicResetsVf', 'clipSprites', 'waitForRelease'];

  function quirkBits(q) {
    var bits = '';
    for (var i = 0; i < QUIRK_KEYS.length; i++) { bits += q[QUIRK_KEYS[i]] ? '1' : '0'; }
    return bits;
  }

  function keyOrMinus(v) { return v === null || v === undefined ? -1 : v; }

  // Diagnostic history is observable machine state, so it participates in the
  // canonical serialization: entries pack as fixed-position tuples and the
  // per-code tally packs as sorted [code, count] pairs, making the encoding
  // independent of key insertion order.
  function packDiagnostics(list) {
    var out = [];
    list = list || [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i] || {};
      out.push([d.cycle, d.pc, d.code, d.severity, d.message]);
    }
    return JSON.stringify(out);
  }
  function packDiagnosticCounts(counts) {
    var out = [], keys = Object.keys(counts || {}).sort();
    for (var i = 0; i < keys.length; i++) { out.push([keys[i], counts[keys[i]]]); }
    return JSON.stringify(out);
  }

  // A fixed-order serialization of every observable machine field, including
  // the deterministic RNG cursor and the diagnostic history. Two CPUs produce
  // the same string iff their full execution state is identical. Works on a
  // live machine as well as a plain staged-state object so restoreState() can
  // hash before committing.
  function canonicalFrom(s) {
    return [
      'chipper8-v2',
      s.pc, s.I, s.sp, s.lastOpcode, s.lastFetchPc,
      packBytes(s.V), packWords(s.stack), packBytes(s.keys),
      s.delayTimer, s.soundTimer, s.traceCyclePhase,
      s.halted ? 1 : 0, JSON.stringify(s.error), s.drawFlag ? 1 : 0,
      s.instructionsExecuted,
      keyOrMinus(s.waitingForKey), keyOrMinus(s.waitKey), keyOrMinus(s.releasedKey),
      quirkBits(s.quirks),
      s.rngKind, s.rngState, s.rngSeed === undefined ? null : s.rngSeed,
      packBytes(s.memory), packBits(s.display),
      packDiagnostics(s.diagnostics), packDiagnosticCounts(s.diagnosticCounts)
    ].join('|');
  }

  // Byte-exact copy of the canonical serialization emitted before
  // traceCyclePhase joined the hash (snapshot format version 2). restoreState
  // uses it only to verify the embedded digest of snapshots written by older
  // builds; live hashing always goes through canonicalFrom above.
  function canonicalFromV2(s) {
    return [
      'chipper8-v2',
      s.pc, s.I, s.sp, s.lastOpcode, s.lastFetchPc,
      packBytes(s.V), packWords(s.stack), packBytes(s.keys),
      s.delayTimer, s.soundTimer,
      s.halted ? 1 : 0, JSON.stringify(s.error), s.drawFlag ? 1 : 0,
      s.instructionsExecuted,
      keyOrMinus(s.waitingForKey), keyOrMinus(s.waitKey), keyOrMinus(s.releasedKey),
      quirkBits(s.quirks),
      s.rngKind, s.rngState, s.rngSeed === undefined ? null : s.rngSeed,
      packBytes(s.memory), packBits(s.display),
      packDiagnostics(s.diagnostics), packDiagnosticCounts(s.diagnosticCounts)
    ].join('|');
  }

  Chip8.prototype.canonicalState = function () {
    var rng = rngDescriptor(this.rng);
    return canonicalFrom({
      pc: this.pc, I: this.I, sp: this.sp,
      lastOpcode: this.lastOpcode, lastFetchPc: this.lastFetchPc,
      V: this.V, stack: this.stack, keys: this.keys,
      delayTimer: this.delayTimer, soundTimer: this.soundTimer,
      traceCyclePhase: this.traceCyclePhase,
      halted: this.halted, error: this.error, drawFlag: this.drawFlag,
      instructionsExecuted: this.instructionsExecuted,
      waitingForKey: this.waitingForKey, waitKey: this.waitKey, releasedKey: this.releasedKey,
      quirks: this.quirks,
      rngKind: rng.kind, rngState: rng.state,
      rngSeed: this.rng && Number.isInteger(this.rng.rngSeed) ? this.rng.rngSeed : null,
      memory: this.memory, display: this.display,
      diagnostics: this.diagnostics, diagnosticCounts: this.diagnosticCounts
    });
  };

  // Canonical state hash: FNV-1a over the serialization above.
  Chip8.prototype.stateHash = function () { return fnv1a(this.canonicalState()); };

  Chip8.prototype.snapshotState = function () {
    var rng = rngDescriptor(this.rng);
    return {
      format: 'chipper8-snapshot',
      version: 3,
      hashAlgorithm: 'fnv1a-32',
      stateHash: this.stateHash(),
      pc: this.pc,
      i: this.I,
      sp: this.sp,
      lastOpcode: this.lastOpcode,
      lastFetchPc: this.lastFetchPc,
      v: Array.prototype.slice.call(this.V),
      stack: Array.prototype.slice.call(this.stack),
      keys: Array.prototype.slice.call(this.keys),
      delayTimer: this.delayTimer,
      soundTimer: this.soundTimer,
      traceCyclePhase: this.traceCyclePhase,
      halted: this.halted,
      error: this.error,
      drawFlag: this.drawFlag,
      instructionsExecuted: this.instructionsExecuted,
      waitingForKey: this.waitingForKey,
      waitKey: this.waitKey,
      releasedKey: this.releasedKey,
      quirks: quirkFlags(this.quirks),
      rngKind: rng.kind,
      rngState: rng.state === -1 ? null : rng.state,
      rngSeed: this.rng && Number.isInteger(this.rng.rngSeed) ? this.rng.rngSeed : null,
      diagnostics: this.diagnostics.map(function (d) {
        return { cycle: d.cycle, pc: d.pc, code: d.code, severity: d.severity, message: d.message };
      }),
      diagnosticCounts: Object.assign(Object.create(null), this.diagnosticCounts),
      memory: packBytes(this.memory),
      vram: packBits(this.display)
    };
  };

  Chip8.prototype.exportState = function () {
    return JSON.stringify(this.snapshotState(), null, 2);
  };

  // Restore a snapshot produced by snapshotState(). Versions 2 and 3 are
  // accepted: version 2 predates traceCyclePhase in both the schema and the
  // canonical hash, so the field is optional there (absent resumes the timer
  // schedule at phase 0) and its digest verifies against the frozen v2
  // serialization. Version 3 requires the field like every other canonical
  // field. Every field, the schema version, the hash algorithm and the
  // mandatory embedded state hash are validated against a staged copy first;
  // the live machine is only touched after the entire staged state decodes
  // cleanly and hashes to the exact embedded digest, so a rejected restore
  // leaves the receiver untouched.
  Chip8.prototype.restoreState = function (snap) {
    if (!snap || typeof snap !== 'object') { throw new RangeError('Snapshot must be an object.'); }
    if (snap.format !== 'chipper8-snapshot' || (snap.version !== 2 && snap.version !== 3)) {
      throw new RangeError('Unsupported snapshot format.');
    }
    if (snap.hashAlgorithm !== 'fnv1a-32') {
      throw new RangeError('Unsupported snapshot hash algorithm.');
    }
    if (typeof snap.stateHash !== 'string' || !/^[0-9a-f]{8}$/.test(snap.stateHash)) {
      throw new RangeError('Snapshot state hash is missing or malformed.');
    }
    function needInt(value, lo, hi, name) {
      if (!Number.isInteger(value) || value < lo || value > hi) {
        throw new RangeError('Snapshot field ' + name + ' is out of range.');
      }
      return value;
    }
    function needBool(value, name) {
      if (typeof value !== 'boolean') { throw new RangeError('Snapshot field ' + name + ' must be boolean.'); }
      return value;
    }
    function needBytes(arr, len, name, hi) {
      if (!arr || typeof arr.length !== 'number' || arr.length !== len) {
        throw new RangeError('Snapshot field ' + name + ' must hold ' + len + ' values.');
      }
      var out = new Uint8Array(len);
      for (var i = 0; i < len; i++) { out[i] = needInt(arr[i], 0, hi, name); }
      return out;
    }
    function needKey(value, name) {
      if (value === null) { return null; }
      return needInt(value, 0, NUM_REGISTERS - 1, name);
    }
    function needStr(value, name) {
      if (typeof value !== 'string') { throw new RangeError('Snapshot field ' + name + ' must be a string.'); }
      return value;
    }

    // Stage: decode and range-check every field without touching `this`.
    var staged = {
      pc: needInt(snap.pc, 0, 0xFFFF, 'pc'),
      I: needInt(snap.i, 0, 0xFFF, 'i'),
      sp: needInt(snap.sp, 0, STACK_SIZE, 'sp'),
      lastOpcode: needInt(snap.lastOpcode, 0, 0xFFFF, 'lastOpcode'),
      lastFetchPc: needInt(snap.lastFetchPc, 0, 0xFFFF, 'lastFetchPc'),
      V: needBytes(snap.v, NUM_REGISTERS, 'v', 0xFF),
      keys: needBytes(snap.keys, NUM_REGISTERS, 'keys', 1),
      stack: new Uint16Array(STACK_SIZE),
      delayTimer: needInt(snap.delayTimer, 0, 0xFF, 'delayTimer'),
      soundTimer: needInt(snap.soundTimer, 0, 0xFF, 'soundTimer'),
      // -1 is the legitimate parked value a just-fired tick leaves behind;
      // the next step() edge absorbs it back to 0. Version 2 snapshots
      // predating the field resume the schedule at its start (phase 0); a
      // present value is range-checked like any other field.
      traceCyclePhase: snap.version === 2 && snap.traceCyclePhase === undefined ? 0 :
        needInt(snap.traceCyclePhase, -1, Number.MAX_SAFE_INTEGER, 'traceCyclePhase'),
      halted: needBool(snap.halted, 'halted'),
      drawFlag: needBool(snap.drawFlag, 'drawFlag'),
      instructionsExecuted: needInt(snap.instructionsExecuted, 0, Number.MAX_SAFE_INTEGER, 'instructionsExecuted'),
      waitingForKey: needKey(snap.waitingForKey, 'waitingForKey'),
      waitKey: needKey(snap.waitKey, 'waitKey'),
      releasedKey: needKey(snap.releasedKey, 'releasedKey'),
      quirks: {},
      memory: unpackHex(snap.memory, MEMORY_SIZE, 'memory'),
      display: unpackBits(snap.vram, DISPLAY_WIDTH * DISPLAY_HEIGHT),
      diagnostics: [],
      // A null-prototype map matches the live machine and keeps a literal
      // '__proto__' count key as data instead of hitting the setter.
      diagnosticCounts: Object.create(null)
    };
    if (!snap.stack || snap.stack.length !== STACK_SIZE) { throw new RangeError('Snapshot field stack must hold ' + STACK_SIZE + ' values.'); }
    for (var s = 0; s < STACK_SIZE; s++) { staged.stack[s] = needInt(snap.stack[s], 0, 0xFFFF, 'stack'); }
    if (snap.error !== null && typeof snap.error !== 'string') { throw new RangeError('Snapshot field error must be null or a string.'); }
    staged.error = snap.error;
    if (!snap.quirks || typeof snap.quirks !== 'object') { throw new RangeError('Snapshot quirks are missing.'); }
    for (var q = 0; q < QUIRK_KEYS.length; q++) {
      var key = QUIRK_KEYS[q];
      staged.quirks[key] = needBool(snap.quirks[key], 'quirks.' + key);
    }
    if (typeof snap.rngKind !== 'string') { throw new RangeError('Snapshot field rngKind is missing.'); }
    if (snap.rngKind === 'mulberry32') {
      staged.rngKind = 'mulberry32';
      staged.rngState = needInt(snap.rngState, 0, 0xFFFFFFFF, 'rngState') >>> 0;
      staged.rngSeed = snap.rngSeed === undefined || snap.rngSeed === null
        ? null : needInt(snap.rngSeed, 0, 0xFFFFFFFF, 'rngSeed') >>> 0;
    } else if (snap.rngKind === 'custom-unserializable') {
      staged.rngKind = 'custom-unserializable';
      staged.rngState = -1;
      staged.rngSeed = null;
    } else {
      throw new RangeError('Snapshot rng kind is not supported.');
    }
    if (!Array.isArray(snap.diagnostics)) {
      throw new RangeError('Snapshot field diagnostics must be an array.');
    }
    if (snap.diagnostics.length > Chip8.MAX_DIAGNOSTICS) {
      throw new RangeError('Snapshot diagnostics exceed the ' + Chip8.MAX_DIAGNOSTICS + ' entry cap.');
    }
    for (var di = 0; di < snap.diagnostics.length; di++) {
      var diag = snap.diagnostics[di];
      if (!diag || typeof diag !== 'object' || Array.isArray(diag)) {
        throw new RangeError('Snapshot diagnostics entry ' + di + ' is malformed.');
      }
      staged.diagnostics.push({
        cycle: needInt(diag.cycle, 0, Number.MAX_SAFE_INTEGER, 'diagnostics.cycle'),
        pc: needInt(diag.pc, 0, 0xFFFF, 'diagnostics.pc'),
        code: needStr(diag.code, 'diagnostics.code'),
        severity: needStr(diag.severity, 'diagnostics.severity'),
        message: needStr(diag.message, 'diagnostics.message')
      });
    }
    if (!snap.diagnosticCounts || typeof snap.diagnosticCounts !== 'object' || Array.isArray(snap.diagnosticCounts)) {
      throw new RangeError('Snapshot field diagnosticCounts must be an object.');
    }
    Object.keys(snap.diagnosticCounts).forEach(function (diagKey) {
      staged.diagnosticCounts[diagKey] =
        needInt(snap.diagnosticCounts[diagKey], 1, Number.MAX_SAFE_INTEGER, 'diagnosticCounts.' + diagKey);
    });
    // Consistency: a live machine only ever counts codes it recorded, and
    // tallies never drop below the surviving entries (counts keep
    // accumulating after the visible log reaches the cap). A forged report
    // that disagrees with its own entries cannot mint a live-impossible
    // state under a valid hash.
    var entryTallies = Object.create(null);
    for (var dj = 0; dj < staged.diagnostics.length; dj++) {
      var tallyCode = staged.diagnostics[dj].code;
      entryTallies[tallyCode] = (entryTallies[tallyCode] || 0) + 1;
    }
    Object.keys(entryTallies).forEach(function (tallyKey) {
      if (staged.diagnosticCounts[tallyKey] === undefined ||
          staged.diagnosticCounts[tallyKey] < entryTallies[tallyKey]) {
        throw new RangeError('Snapshot diagnosticCounts under-counts ' + tallyKey + '.');
      }
    });

    // Verify integrity: the staged state must hash to the embedded digest
    // before a single live field is overwritten. Version 2 digests cover the
    // frozen pre-traceCyclePhase serialization; version 3 covers the live one.
    if (fnv1a(snap.version === 2 ? canonicalFromV2(staged) : canonicalFrom(staged)) !== snap.stateHash) {
      throw new RangeError('Snapshot state hash mismatch.');
    }

    // Commit: every check passed, so the staged state is applied in full.
    this.pc = staged.pc; this.I = staged.I; this.sp = staged.sp;
    this.lastOpcode = staged.lastOpcode; this.lastFetchPc = staged.lastFetchPc;
    this.V = staged.V; this.stack = staged.stack; this.keys = staged.keys;
    this.delayTimer = staged.delayTimer; this.soundTimer = staged.soundTimer;
    this.traceCyclePhase = staged.traceCyclePhase;
    this.halted = staged.halted; this.error = staged.error; this.drawFlag = staged.drawFlag;
    this.instructionsExecuted = staged.instructionsExecuted;
    this.waitingForKey = staged.waitingForKey; this.waitKey = staged.waitKey; this.releasedKey = staged.releasedKey;
    // Reference swap, not per-key writes: a frozen, nulled or hostile
    // quirks object on the receiver can no longer strand a half-committed
    // restore; every earlier field is a plain own-property assignment.
    this.quirks = staged.quirks;
    this.memory = staged.memory; this.display = staged.display;
    this.diagnostics = staged.diagnostics;
    this.diagnosticCounts = staged.diagnosticCounts;
    if (staged.rngKind === 'mulberry32') {
      var rebuilt = Chip8.seededRng(staged.rngSeed === null ? staged.rngState : staged.rngSeed);
      rebuilt.rngState = staged.rngState;
      this.rng = rebuilt;
    } else if (rngDescriptor(this.rng).kind !== 'custom-unserializable') {
      // The recorded generator could not be serialized; fall back so the
      // restored machine still hashes to the snapshot's canonical state.
      this.rng = Math.random;
    }
    return this;
  };

  // Execute up to `steps` instructions on this machine, recording one entry
  // per executed instruction: fetch address, raw word, quirk-aware
  // disassembly, the post-state I/SP/VF/timer fields and a per-step hash of
  // the full observable state (registers, timers, RNG cursor, RAM and VRAM),
  // so two runs diverge in the hash the moment any machine state does.
  // Blocked FX0A fetches count as step attempts but record no entry unless
  // options.includeStalls is set.
  //
  // Timers: options.timers is 'timed' (default) or 'frozen'. In timed mode
  // the 60 Hz delay and sound timers tick once per options.cyclesPerTick
  // CPU cycle edges (default 12, a 720 Hz CPU), following the same canonical
  // schedule as Clock.advance in the browser run loop: at a CPU cycle edge
  // that coincides with a timer edge the 60 Hz decrement resolves first,
  // before the instruction executes, and cycles keep elapsing while the CPU
  // stalls on an FX0A key wait. The tick phase lives on the machine as
  // traceCyclePhase, maintained by step() and tickTimers() themselves, so
  // chunked traces, raw stepping and the live bench all continue the same
  // schedule a single call would produce. The exact mode and rate are
  // recorded in the export's timerSchedule field; frozen mode sets
  // cyclesPerTick/cpuHz to null as an explicit CPU-only trace whose steps
  // consume no 60 Hz cycle edges, leaving traceCyclePhase untouched.
  Chip8.prototype.trace = function (steps, options) {
    if (!Number.isInteger(steps) || steps < 0) {
      throw new RangeError('Trace steps must be a non-negative integer.');
    }
    var includeStalls = !!(options && options.includeStalls);
    var timersMode = 'timed';
    if (options && options.timers !== undefined) {
      if (options.timers !== 'timed' && options.timers !== 'frozen') {
        throw new RangeError("Trace timers must be 'timed' or 'frozen'.");
      }
      timersMode = options.timers;
    }
    var cyclesPerTick = (options && options.cyclesPerTick !== undefined) ? options.cyclesPerTick : 12;
    if (!Number.isInteger(cyclesPerTick) || cyclesPerTick < 1 || cyclesPerTick > 1000000) {
      throw new RangeError('cyclesPerTick must be an integer from 1 to 1000000.');
    }
    var entries = [];
    // The tick phase lives on the machine and is maintained by step() and
    // tickTimers() themselves, so chunked traces, raw stepping and the live
    // Clock bench all continue the same 60 Hz schedule. A missing,
    // malformed or overdue phase self-heals to zero rather than skipping a
    // tick; -1 is the legitimate parked value a just-fired tick leaves.
    if (!Number.isInteger(this.traceCyclePhase) || this.traceCyclePhase < -1 ||
        (timersMode === 'timed' && this.traceCyclePhase >= cyclesPerTick)) {
      this.traceCyclePhase = 0;
    }
    // Frozen traces are CPU-only: their steps must not consume 60 Hz cycle
    // edges, or each one would shift the shared timer schedule by a phase.
    // The flag is transient run control, never canonical state, so it stays
    // out of snapshots and hashes; step() skips its phase increment while set.
    var prevTimersFrozen = this.traceTimersFrozen;
    this.traceTimersFrozen = timersMode === 'frozen';
    try {
      for (var i = 0; i < steps && !this.halted; i++) {
        var pcBefore = this.pc;
        var executedBefore = this.instructionsExecuted;
        // Canonical schedule shared with Clock.advance: when a 60 Hz timer
        // edge and a CPU cycle edge coincide, the timer decrement resolves
        // before the instruction. Stalled FX0A fetches are cycle edges too,
        // so timers keep ticking during a key wait exactly like the live
        // bench. tickTimers() parks the phase at -1 and this edge's step()
        // increment lands it back on 0.
        if (timersMode === 'timed' && this.traceCyclePhase + 1 >= cyclesPerTick) {
          this.tickTimers();
        }
        var op = this.step();
        if (this.instructionsExecuted === executedBefore) {
          if (includeStalls) {
            // A fault (for example a PC range error) also consumes the edge
            // without executing; mark it so it is not mistaken for a key wait.
            var stallEntry = { stall: true, pc: pcBefore, op: op, mnemonic: this.disassembleEffective(op),
              dt: this.delayTimer, st: this.soundTimer };
            if (this.error) { stallEntry.fault = true; }
            entries.push(stallEntry);
          }
          continue;
        }
        var entry = {
          n: this.instructionsExecuted,
          pc: pcBefore,
          op: op,
          mnemonic: this.disassembleEffective(op),
          i: this.I,
          sp: this.sp,
          vf: this.V[0xF],
          dt: this.delayTimer,
          st: this.soundTimer,
          h: this.stateHash()
        };
        if ((op & 0xF000) === 0xB000) { entry.target = this.pc; }
        entries.push(entry);
      }
    } finally {
      this.traceTimersFrozen = prevTimersFrozen;
    }
    return {
      format: 'chipper8-trace',
      version: 2,
      hashAlgorithm: 'fnv1a-32',
      quirks: quirkFlags(this.quirks),
      timerSchedule: {
        mode: timersMode,
        timerHz: 60,
        cyclesPerTick: timersMode === 'timed' ? cyclesPerTick : null,
        cpuHz: timersMode === 'timed' ? cyclesPerTick * 60 : null
      },
      instructions: this.instructionsExecuted,
      halted: this.halted,
      error: this.error,
      diagnostics: this.diagnostics.slice(),
      entries: entries,
      finalHash: this.stateHash()
    };
  };

  // Build a fresh machine, seed its RNG, load a ROM and return the trace.
  // Same ROM + seed + quirks always yields a byte-identical report.
  Chip8.traceProgram = function (rom, steps, options) {
    options = options || {};
    var cpu = new Chip8();
    if (options.profile !== undefined) { cpu.setProfile(options.profile); }
    if (options.quirks !== undefined) {
      for (var q = 0; q < QUIRK_KEYS.length; q++) {
        var key = QUIRK_KEYS[q];
        if (Object.prototype.hasOwnProperty.call(options.quirks, key)) {
          if (typeof options.quirks[key] !== 'boolean') { throw new RangeError('Quirk flags must be boolean.'); }
          cpu.quirks[key] = options.quirks[key];
        }
      }
    }
    var seed = options.seed === undefined ? 0xC8 : options.seed;
    cpu.rng = Chip8.seededRng(seed);
    cpu.load(rom);
    var result = cpu.trace(steps, options);
    result.meta = {
      romBytes: (rom && typeof rom.length === 'number') ? rom.length : 0,
      seed: seed,
      profile: options.profile || 'custom',
      timers: result.timerSchedule.mode,
      cyclesPerTick: result.timerSchedule.cyclesPerTick
    };
    return result;
  };

  function isAssignedOpcode(word) {
    var family = (word & 0xF000) >> 12;
    var n = word & 0x000F;
    var kk = word & 0x00FF;
    switch (family) {
      case 0x0: return true; // every 0NNN decodes as SYS/CLS/RET
      case 0x5: case 0x9: return n === 0;
      case 0x8: return n <= 0x7 || n === 0xE;
      case 0xE: return kk === 0x9E || kk === 0xA1;
      case 0xF: return kk === 0x07 || kk === 0x0A || kk === 0x15 || kk === 0x18 ||
        kk === 0x1E || kk === 0x29 || kk === 0x33 || kk === 0x55 || kk === 0x65;
      default: return true;
    }
  }

  // Static lint over ROM bytes without executing anything. Reports structural
  // errors (bad input), warnings (odd length, control flow into low or
  // unloaded memory) and informational notes (SYS no-ops, unassigned words
  // that are probably sprite data, zero-height draws).
  Chip8.validateRom = function (rom) {
    var diagnostics = [];
    function add(code, severity, offset, message) {
      diagnostics.push({ code: code, severity: severity, offset: offset, message: message });
    }
    var bytes = rom;
    if (typeof rom === 'string') {
      bytes = [];
      for (var s = 0; s < rom.length; s++) { bytes.push(rom.charCodeAt(s) & 0xFF); }
    }
    var usable = false;
    if (!bytes || !Number.isInteger(bytes.length)) {
      add('NOT_BYTES', 'error', -1, 'ROM must be an array of byte values.');
    } else if (bytes.length < 1) {
      add('EMPTY_ROM', 'error', -1, 'ROM is empty.');
    } else if (bytes.length > MEMORY_SIZE - PROGRAM_START) {
      add('OVERSIZE_ROM', 'error', -1, 'ROM exceeds the ' + (MEMORY_SIZE - PROGRAM_START) + '-byte cartridge space.');
    } else {
      usable = true;
      for (var b = 0; b < bytes.length; b++) {
        if (!Number.isInteger(bytes[b]) || bytes[b] < 0 || bytes[b] > 255) {
          add('BAD_BYTE', 'error', PROGRAM_START + b, 'Value at offset ' + b + ' is not a byte.');
          usable = false;
          break;
        }
      }
    }
    if (usable) {
      if (bytes.length % 2 === 1) {
        add('ODD_LENGTH', 'warning', PROGRAM_START + bytes.length - 1,
          'Odd length: the final byte cannot fill a 16-bit instruction.');
      }
      var end = PROGRAM_START + bytes.length;
      var unassigned = 0, UNASSIGNED_CAP = 8;
      for (var off = 0; off + 1 < bytes.length; off += 2) {
        var word = (bytes[off] << 8) | bytes[off + 1];
        var family = (word & 0xF000) >> 12;
        var n = word & 0x000F;
        var nnn = word & 0x0FFF;
        var addr = PROGRAM_START + off;
        if (!isAssignedOpcode(word)) {
          unassigned++;
          if (unassigned <= UNASSIGNED_CAP) {
            add('UNASSIGNED_WORD', 'info', addr,
              'Word ' + hex(word, 4) + ' is not an assigned opcode (may be sprite data).');
          }
          continue;
        }
        if (family === 0x0 && word !== 0x00E0 && word !== 0x00EE) {
          add('SYS_USED', 'info', addr, 'SYS ' + hex(nnn, 3) + ' is a no-op machine call on this interpreter.');
        }
        if (family === 0xD && n === 0) {
          add('DRW_ZERO_HEIGHT', 'info', addr, 'DRW with height 0 draws nothing on this interpreter.');
        }
        if (family === 0x1 || family === 0x2) {
          if (nnn < PROGRAM_START) {
            add('JUMP_LOW_MEM', 'warning', addr, 'Control flow targets the interpreter area below 0x200.');
          } else if (nnn >= end) {
            add('JUMP_BEYOND_ROM', 'warning', addr, 'Control flow targets memory past the end of the ROM.');
          }
        }
      }
      if (unassigned > UNASSIGNED_CAP) {
        add('UNASSIGNED_MORE', 'info', -1, (unassigned - UNASSIGNED_CAP) + ' more unassigned words suppressed.');
      }
    }
    var errors = 0, warnings = 0, infos = 0;
    for (var d = 0; d < diagnostics.length; d++) {
      if (diagnostics[d].severity === 'error') { errors++; }
      else if (diagnostics[d].severity === 'warning') { warnings++; }
      else { infos++; }
    }
    return { ok: errors === 0, errors: errors, warnings: warnings, infos: infos, diagnostics: diagnostics };
  };

  Chip8.FONTSET = FONTSET;
  Chip8.MEMORY_SIZE = MEMORY_SIZE;
  Chip8.PROGRAM_START = PROGRAM_START;
  Chip8.DISPLAY_WIDTH = DISPLAY_WIDTH;
  Chip8.DISPLAY_HEIGHT = DISPLAY_HEIGHT;
  Chip8.hex = hex;

  return Chip8;
}));
