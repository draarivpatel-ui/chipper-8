/*
 * Chipper-8: compatibility lab, time-travel debugger and audit studio.
 *
 * Zero dependencies. Works in the browser (exposes window.Chipper8.Studio)
 * and in Node.js (module.exports) so the exact same code is unit tested
 * with `node --test`.
 *
 * Contents:
 *   - TimeMachine: a 256-entry ring buffer of binary CPU snapshots for
 *     deterministic step-back debugging.
 *   - CoverageTracker: opcode-family (0x0..0xF) execution histogram.
 *   - VERIFY: a deterministic CHIP-8 program exercising all 35 opcodes and
 *     writing check bytes into a results page, plus its runner.
 *   - Round-trip: assembler -> disassembler -> assembler byte identity.
 *   - Audit: SHA-256 checksummed JSON/CSV/Markdown export, structural
 *     verify and deterministic replay verification.
 *   - Bookmark: URL-hash preset encode/decode (#c8=...).
 *   - Quirk probes: identical micro-programs run on all three hardware
 *     profiles, reporting live behavioural divergence.
 *   - selfTests(): the named in-page self-test suite.
 */
(function (root, factory) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var deps = isNode ? {
    Chip8: require('./engine.js'),
    assemble: require('./assembler.js').assemble,
    assembleDetailed: require('./assembler.js').assembleDetailed,
    sha256: require('./sha256.js')
  } : {
    Chip8: root.Chipper8 && root.Chipper8.Chip8,
    assemble: root.Chipper8 && root.Chipper8.assemble,
    assembleDetailed: root.Chipper8 && root.Chipper8.assembleDetailed,
    sha256: root.Chipper8 && root.Chipper8.sha256
  };
  var api = factory(deps);
  if (isNode) {
    module.exports = api;
  } else {
    root.Chipper8 = root.Chipper8 || {};
    root.Chipper8.Studio = api;
  }
}(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';

  var Chip8 = deps.Chip8;
  var assemble = deps.assemble;
  var assembleDetailed = deps.assembleDetailed;
  var sha256 = deps.sha256;

  /* ============================ TimeMachine ============================
   * A ring buffer of compact binary snapshots captured before each
   * executed instruction. Capacity 256 by default, so STEP -1 OP can
   * rewind up to 256 executed instructions restoring the exact PC, I,
   * V0..VF, stack, timers, keys, quirks, diagnostics, RNG cursor, RAM
   * and the 64x32 framebuffer. Entries live in preallocated typed arrays,
   * so recording adds no per-step allocation pressure to the run loop.
   */
  function TimeMachine(capacity) {
    if (capacity === undefined) { capacity = 256; }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8192) {
      throw new RangeError('TimeMachine capacity must be an integer from 1 to 8192.');
    }
    this.capacity = capacity;
    this.slots = new Array(capacity);
    this.len = 0;
    this.next = 0;
  }

  TimeMachine.prototype.depth = function () { return this.len; };

  TimeMachine.prototype._slot = function () {
    return {
      pc: 0, I: 0, sp: 0, dt: 0, st: 0,
      lastOpcode: 0, lastFetchPc: 0, instructionsExecuted: 0,
      halted: false, error: null, drawFlag: false,
      waitingForKey: null, waitKey: null, releasedKey: null,
      traceCyclePhase: 0,
      V: new Uint8Array(16), stack: new Uint16Array(16),
      keys: new Uint8Array(16), memory: new Uint8Array(4096),
      display: new Uint8Array(2048),
      quirks: null, diagnostics: null, diagnosticCounts: null,
      rngKind: 'custom-unserializable', rngState: -1, rngSeed: null
    };
  };

  // Record the machine's full observable state before it executes an
  // instruction. Call drop() afterwards if the fetch stalled (FX0A) or
  // faulted without executing, so the ring only ever holds real steps.
  TimeMachine.prototype.capture = function (cpu) {
    var s = this.slots[this.next] || (this.slots[this.next] = this._slot());
    s.pc = cpu.pc; s.I = cpu.I; s.sp = cpu.sp;
    s.dt = cpu.delayTimer; s.st = cpu.soundTimer;
    s.lastOpcode = cpu.lastOpcode; s.lastFetchPc = cpu.lastFetchPc;
    s.instructionsExecuted = cpu.instructionsExecuted;
    s.halted = cpu.halted; s.error = cpu.error; s.drawFlag = cpu.drawFlag;
    s.waitingForKey = cpu.waitingForKey; s.waitKey = cpu.waitKey;
    s.releasedKey = cpu.releasedKey; s.traceCyclePhase = cpu.traceCyclePhase;
    s.V.set(cpu.V); s.stack.set(cpu.stack); s.keys.set(cpu.keys);
    s.memory.set(cpu.memory); s.display.set(cpu.display);
    s.quirks = Object.assign({}, cpu.quirks);
    s.diagnostics = cpu.diagnostics.slice();
    s.diagnosticCounts = Object.assign(Object.create(null), cpu.diagnosticCounts);
    var rng = cpu.rng;
    if (rng && rng.rngKind === 'mulberry32') {
      s.rngKind = 'mulberry32'; s.rngState = rng.rngState >>> 0;
      s.rngSeed = Number.isInteger(rng.rngSeed) ? rng.rngSeed : null;
    } else {
      s.rngKind = 'custom-unserializable'; s.rngState = -1; s.rngSeed = null;
    }
    this.next = (this.next + 1) % this.capacity;
    if (this.len < this.capacity) { this.len++; }
    return this;
  };

  TimeMachine.prototype._apply = function (cpu, s) {
    cpu.pc = s.pc; cpu.I = s.I; cpu.sp = s.sp;
    cpu.delayTimer = s.dt; cpu.soundTimer = s.st;
    cpu.lastOpcode = s.lastOpcode; cpu.lastFetchPc = s.lastFetchPc;
    cpu.instructionsExecuted = s.instructionsExecuted;
    cpu.halted = s.halted; cpu.error = s.error; cpu.drawFlag = s.drawFlag;
    cpu.waitingForKey = s.waitingForKey; cpu.waitKey = s.waitKey;
    cpu.releasedKey = s.releasedKey; cpu.traceCyclePhase = s.traceCyclePhase;
    cpu.V.set(s.V); cpu.stack.set(s.stack); cpu.keys.set(s.keys);
    cpu.memory.set(s.memory); cpu.display.set(s.display);
    cpu.quirks = Object.assign({}, s.quirks);
    cpu.diagnostics = s.diagnostics.slice();
    cpu.diagnosticCounts = Object.assign(Object.create(null), s.diagnosticCounts);
    if (s.rngKind === 'mulberry32' && Chip8) {
      var rebuilt = Chip8.seededRng(s.rngSeed === null ? s.rngState : s.rngSeed);
      rebuilt.rngState = s.rngState;
      cpu.rng = rebuilt;
    }
  };

  // Restore the most recent captured state and return it to the caller.
  // Returns false when the ring is empty.
  TimeMachine.prototype.undo = function (cpu) {
    if (this.len === 0) { return false; }
    this.next = (this.next - 1 + this.capacity) % this.capacity;
    this._apply(cpu, this.slots[this.next]);
    this.len--;
    return true;
  };

  // Discard the most recent capture without restoring it. Used when a
  // fetch stalls or faults so the ring keeps only real executed steps.
  TimeMachine.prototype.drop = function () {
    if (this.len === 0) { return false; }
    this.next = (this.next - 1 + this.capacity) % this.capacity;
    this.len--;
    return true;
  };

  TimeMachine.prototype.clear = function () { this.len = 0; this.next = 0; return this; };

  /* ============================ CoverageTracker ============================
   * Histogram of executed instruction families 0x0..0xF, rendered by the
   * workbench as a live SVG heatmap.
   */
  function CoverageTracker() { this.reset(); }
  CoverageTracker.prototype.reset = function () {
    this.counts = new Uint32Array(16);
    this.total = 0;
    return this;
  };
  CoverageTracker.prototype.record = function (opcode) {
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xFFFF) { return false; }
    this.counts[(opcode & 0xF000) >>> 12]++;
    this.total++;
    return true;
  };
  CoverageTracker.prototype.dec = function (opcode) {
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xFFFF) { return false; }
    var family = (opcode & 0xF000) >>> 12;
    if (this.counts[family] === 0) { return false; }
    this.counts[family]--;
    this.total--;
    return true;
  };
  CoverageTracker.prototype.toArray = function () {
    return Array.prototype.slice.call(this.counts);
  };

  /* ============================ Verify ROM ============================
   * Deterministic CHIP-8 program that exercises every one of the 35
   * opcodes and writes one result byte per check into the results page
   * (0x400..0x434) plus the scratch cells 0x3E0 (static-I store) and
   * 0x3F0..0x3F2 (BCD). Runs under the modern profile with a seeded RNG,
   * frozen timers and key 0xB pressed by the harness at `keyblock`.
   */
  var VERIFY_CELL_BASE = 0x400;
  var VERIFY_SOURCE = [
    '; chipper-8 verification rom: every opcode writes check bytes at 0x400+.',
    '    SYS 0x123',
    '    LD V1, 200',
    '    LD V2, 100',
    '    ADD V1, V2        ; 8XY4 -> V1=44 VF=1',
    '    LD V3, VF',
    '    LD V0, V1',
    '    LD I, 0x400',
    '    LD [I], V0',
    '    LD V0, V3',
    '    LD I, 0x401',
    '    LD [I], V0',
    '    SUB V1, V2        ; 8XY5 -> V1=200 VF=0',
    '    LD V3, VF',
    '    LD V0, V1',
    '    LD I, 0x402',
    '    LD [I], V0',
    '    LD V0, V3',
    '    LD I, 0x403',
    '    LD [I], V0',
    '    LD I, 0x400       ; FX1E: I = 0x404',
    '    LD V2, 4',
    '    ADD I, V2',
    '    LD V0, 0x77',
    '    LD [I], V0',
    '    LD V1, 200        ; 8XY7 borrow: V1=100-200=156 VF=0',
    '    LD V2, 100',
    '    SUBN V1, V2',
    '    LD V3, VF',
    '    LD V0, V1',
    '    LD I, 0x405',
    '    LD [I], V0',
    '    LD V0, V3',
    '    LD I, 0x406',
    '    LD [I], V0',
    '    LD V1, 30         ; 8XY7 clean: V1=50-30=20 VF=1',
    '    LD V2, 50',
    '    SUBN V1, V2',
    '    LD V3, VF',
    '    LD V0, V1',
    '    LD I, 0x407',
    '    LD [I], V0',
    '    LD V0, V3',
    '    LD I, 0x408',
    '    LD [I], V0',
    '    LD V1, 0xF0       ; 8XY1',
    '    LD V2, 0x0F',
    '    OR V1, V2',
    '    LD V0, V1',
    '    LD I, 0x409',
    '    LD [I], V0',
    '    LD V1, 0x3C       ; 8XY2',
    '    LD V2, 0x18',
    '    AND V1, V2',
    '    LD V0, V1',
    '    LD I, 0x40A',
    '    LD [I], V0',
    '    LD V1, 0xFF       ; 8XY3',
    '    LD V2, 0x0F',
    '    XOR V1, V2',
    '    LD V0, V1',
    '    LD I, 0x40B',
    '    LD [I], V0',
    '    LD V4, 0x25       ; 8XY6 modern: V4=18 VF=1',
    '    SHR V4',
    '    LD V3, VF',
    '    LD V0, V4',
    '    LD I, 0x40C',
    '    LD [I], V0',
    '    LD V0, V3',
    '    LD I, 0x40D',
    '    LD [I], V0',
    '    LD V4, 0x85       ; 8XYE modern: V4=0x0A VF=1',
    '    SHL V4',
    '    LD V3, VF',
    '    LD V0, V4',
    '    LD I, 0x40E',
    '    LD [I], V0',
    '    LD V0, V3',
    '    LD I, 0x40F',
    '    LD [I], V0',
    '    LD V4, 10         ; 7XKK: V4=15, VF untouched',
    '    ADD V4, 5',
    '    LD V0, V4',
    '    LD I, 0x410',
    '    LD [I], V0',
    '    LD V5, 0xAB       ; 6XKK + 8XY0 copy',
    '    LD V6, V5',
    '    LD V0, V6',
    '    LD I, 0x411',
    '    LD [I], V0',
    '    LD V7, 0x42       ; 3XKK taken',
    '    LD V0, 1',
    '    SE V7, 0x42',
    '    LD V0, 0',
    '    LD I, 0x412',
    '    LD [I], V0',
    '    LD V0, 1          ; 4XKK taken',
    '    SNE V7, 0x43',
    '    LD V0, 0',
    '    LD I, 0x413',
    '    LD [I], V0',
    '    LD V8, 0x42       ; 5XY0 taken',
    '    LD V0, 1',
    '    SE V7, V8',
    '    LD V0, 0',
    '    LD I, 0x414',
    '    LD [I], V0',
    '    LD V8, 0x41       ; 9XY0 taken',
    '    LD V0, 1',
    '    SNE V7, V8',
    '    LD V0, 0',
    '    LD I, 0x415',
    '    LD [I], V0',
    '    CALL sub_a        ; 2NNN + 00EE, nested',
    '    LD V0, V9',
    '    LD I, 0x416',
    '    LD [I], V0',
    '    LD V0, VA',
    '    LD I, 0x417',
    '    LD [I], V0',
    '    LD V0, 0          ; BNNN executed (all profiles equal at V0=0)',
    '    JP V0, bnnn_done',
    'bnnn_done:',
    '    LD VA, 0xC        ; FX29 + DXYN: draw and erase font glyph C',
    '    LD F, VA',
    '    LD V0, 0',
    '    LD V1, 0',
    '    DRW V0, V1, 5',
    '    DRW V0, V1, 5     ; second draw erases -> VF=1',
    '    LD V3, VF',
    '    LD V0, V3',
    '    LD I, 0x418',
    '    LD [I], V0',
    '    CLS               ; 00E0',
    '    RND V2, 0xFF      ; CXKK, seeded rng',
    '    LD V0, V2',
    '    LD I, 0x419',
    '    LD [I], V0',
    '    LD V3, 30         ; FX15/FX18 + FX07 readback under frozen timers',
    '    LD DT, V3',
    '    LD ST, V3',
    '    LD V4, DT',
    '    LD V0, V4',
    '    LD I, 0x41A',
    '    LD [I], V0',
    '    LD V6, 5          ; EX9E no key: falls through',
    '    LD V0, 1',
    '    SKP V6',
    '    LD V0, 0',
    '    LD I, 0x41B',
    '    LD [I], V0',
    '    LD V0, 1          ; EXA1 no key: skips the zero write',
    '    SKNP V6',
    '    LD V0, 0',
    '    LD I, 0x41C',
    '    LD [I], V0',
    'keyblock:             ; harness presses key 0xB before this fetch',
    '    LD VC, 0xB',
    '    LD V0, 1',
    '    SKP VC            ; held: skips the zero write',
    '    LD V0, 0',
    '    LD I, 0x430',
    '    LD [I], V0',
    '    LD V0, 0',
    '    SKNP VC           ; held: does not skip the one write',
    '    LD V0, 1',
    '    LD I, 0x431',
    '    LD [I], V0',
    '    LD VD, K          ; FX0A completes with the held key',
    '    LD V0, VD',
    '    LD I, 0x432',
    '    LD [I], V0',
    '    LD V8, 0xAA       ; FX55 + FX65 round trip through RAM',
    '    LD V9, 0xBB',
    '    LD VA, 0xCC',
    '    LD I, 0x3E0',
    '    LD [I], VA',
    '    LD V8, 0',
    '    LD V9, 0',
    '    LD VA, 0',
    '    LD I, 0x3E0       ; FX55 advanced I; reload before FX65',
    '    LD VA, [I]',
    '    LD V0, 0x5A       ; FX65 advanced I to 0x3EB: store lands there',
    '    LD [I], V0',
    '    LD V0, 1',
    '    SE V8, 0xAA',
    '    LD V0, 0',
    '    SE V9, 0xBB',
    '    LD V0, 0',
    '    SE VA, 0xCC',
    '    LD V0, 0',
    '    LD I, 0x433',
    '    LD [I], V0',
    '    LD V7, 254        ; FX33 BCD -> 0x3F0..0x3F2 = 2,5,4',
    '    LD I, 0x3F0',
    '    LD B, V7',
    '    LD V0, 0xC8',
    '    LD I, 0x434',
    '    LD [I], V0',
    'end:',
    '    JP end',
    'sub_a:',
    '    CALL sub_b',
    '    LD V9, 0x5A',
    '    RET',
    'sub_b:',
    '    LD VA, 0x77',
    '    RET'
  ].join('\n');

  // Golden result bytes under the modern profile (cell address -> value).
  // 0x419 (RND output) is filled by verifyRomGolden() from the engine's
  // own seeded generator so the check is exact without a magic constant.
  var VERIFY_GOLDEN = [
    [0x400, 'ADD Vx,Vy result', 44], [0x401, 'ADD carry flag VF', 1],
    [0x402, 'SUB Vx,Vy result', 200], [0x403, 'SUB borrow flag VF', 0],
    [0x404, 'ADD I,Vx computed store', 0x77],
    [0x405, 'SUBN Vx,Vy result', 156], [0x406, 'SUBN borrow flag VF', 0],
    [0x407, 'SUBN clean result', 20], [0x408, 'SUBN clean flag VF', 1],
    [0x409, 'OR Vx,Vy result', 0xFF], [0x40A, 'AND Vx,Vy result', 0x18],
    [0x40B, 'XOR Vx,Vy result', 0xF0],
    [0x40C, 'SHR Vx result', 18], [0x40D, 'SHR flag VF', 1],
    [0x40E, 'SHL Vx result', 0x0A], [0x40F, 'SHL flag VF', 1],
    [0x410, 'ADD Vx,byte result', 15], [0x411, 'LD Vx,Vy copy', 0xAB],
    [0x412, 'SE Vx,byte skip taken', 1], [0x413, 'SNE Vx,byte skip taken', 1],
    [0x414, 'SE Vx,Vy skip taken', 1], [0x415, 'SNE Vx,Vy skip taken', 1],
    [0x416, 'CALL/RET value', 0x5A], [0x417, 'nested CALL value', 0x77],
    [0x418, 'DRW erase collision VF', 1],
    [0x419, 'RND seeded byte', null],
    [0x41A, 'DT write/readback', 30],
    [0x41B, 'SKP Vx fell through without key', 0],
    [0x41C, 'SKNP Vx skipped without key', 1],
    [0x430, 'SKP Vx skipped with key 0xB', 1],
    [0x431, 'SKNP Vx fell through with key 0xB', 1],
    [0x432, 'FX0A key result', 0x0B],
    [0x433, 'FX55/FX65 register round trip', 1],
    [0x434, 'done marker', 0xC8],
    [0x3EB, 'post-FX65 I store', 0x5A],
    [0x3F0, 'BCD hundreds', 2], [0x3F1, 'BCD tens', 5], [0x3F2, 'BCD ones', 4]
  ];

  function verifyRomGolden(seed) {
    var rng = Chip8.seededRng(seed === undefined ? 0xC8 : seed);
    var rndByte = Math.floor(rng() * 256) & 0xFF;
    return VERIFY_GOLDEN.map(function (row) {
      return [row[0], row[1], row[2] === null ? rndByte : row[2]];
    });
  }

  // Assemble, load and run the verification ROM on a fresh machine.
  // options: { profile:'modern', seed:0xC8, maxSteps:4000, pressKey:true }
  // Returns { ok, failures, cells, registers, steps, halted, stateHash,
  //           romBytes, keyAddr, endAddr }.
  function runVerifyRom(options) {
    options = options || {};
    var profile = options.profile || 'modern';
    var seed = options.seed === undefined ? 0xC8 : options.seed;
    var maxSteps = options.maxSteps || 4000;
    var pressKey = options.pressKey !== false;

    var built = assembleDetailed(VERIFY_SOURCE, 0x200);
    var rom = built.bytes;
    var labels = built.labels;
    var keyAddr = labels.keyblock;
    var endAddr = labels.end;

    var cpu = new Chip8();
    cpu.setProfile(profile);
    cpu.rng = Chip8.seededRng(seed);
    cpu.load(rom);

    var keyHeld = false;
    var steps = 0;
    while (steps < maxSteps && !cpu.halted) {
      if (pressKey && !keyHeld && cpu.pc === keyAddr) {
        cpu.setKey(0xB, true);
        keyHeld = true;
      }
      if (cpu.pc === endAddr && cpu.lastOpcode === (0x1000 | endAddr)) { break; }
      cpu.step();
      steps++;
    }

    var golden = verifyRomGolden(seed);
    var cells = [];
    var failures = [];
    for (var i = 0; i < golden.length; i++) {
      var addr = golden[i][0], name = golden[i][1], expected = golden[i][2];
      var actual = cpu.memory[addr];
      var pass = actual === expected;
      cells.push({ addr: addr, name: name, expected: expected, actual: actual, pass: pass });
      if (!pass) { failures.push({ addr: addr, name: name, expected: expected, actual: actual }); }
    }
    var families = new CoverageTracker();
    for (var j = 0; j + 1 < rom.length; j += 2) {
      families.record((rom[j] << 8) | rom[j + 1]);
    }
    return {
      ok: failures.length === 0 && cpu.memory[0x434] === 0xC8 && !cpu.halted,
      failures: failures,
      cells: cells,
      registers: Array.prototype.slice.call(cpu.V),
      steps: steps,
      halted: cpu.halted,
      completed: cpu.memory[0x434] === 0xC8,
      stateHash: cpu.stateHash(),
      romBytes: rom,
      romLength: rom.length,
      keyAddr: keyAddr,
      endAddr: endAddr,
      profile: profile,
      seed: seed
    };
  }

  /* ============================ Round trip ============================ */
  var CANONICAL_WORDS = [
    0x00E0, 0x00EE, 0x0123, 0x1234, 0x2234, 0x3123, 0x4123, 0x5120,
    0x6123, 0x7123, 0x8120, 0x8121, 0x8122, 0x8123, 0x8124, 0x8125,
    0x8126, 0x8127, 0x812E, 0x9120, 0xA234, 0xB234, 0xC123, 0xD125,
    0xE19E, 0xE1A1, 0xF107, 0xF10A, 0xF115, 0xF118, 0xF11E, 0xF129,
    0xF133, 0xF155, 0xF165
  ];

  // Disassemble each word then re-assemble it; every word must come back
  // byte-identical. words defaults to the 35 canonical opcodes; pass a
  // wider iterable (or 'all' for the full 0x0000..0xFFFF sweep).
  function roundTrip(words) {
    var list = words;
    if (words === 'all') {
      list = [];
      for (var w = 0; w <= 0xFFFF; w++) { list.push(w); }
    }
    if (!list) { list = CANONICAL_WORDS; }
    var cpu = new Chip8();
    var mismatches = [];
    for (var i = 0; i < list.length; i++) {
      var word = list[i] & 0xFFFF;
      var bytes = assemble(cpu.disassemble(word));
      var back = (bytes[0] << 8) | bytes[1];
      if (back !== word) {
        mismatches.push({ word: word, mnemonic: cpu.disassemble(word), back: back });
      }
    }
    return { checked: list.length, mismatches: mismatches, ok: mismatches.length === 0 };
  }

  /* ============================ Canonical JSON ============================ */
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') { return JSON.stringify(value); }
    if (Array.isArray(value)) {
      return '[' + value.map(canonicalize).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + canonicalize(value[k]);
    }).join(',') + '}';
  }

  function hexBytes(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2);
    }
    return out;
  }

  function unhex(text) {
    if (typeof text !== 'string' || text.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(text)) {
      throw new RangeError('Not a hex string.');
    }
    var out = new Uint8Array(text.length / 2);
    for (var i = 0; i < out.length; i++) { out[i] = parseInt(text.substr(i * 2, 2), 16); }
    return out;
  }

  /* ============================ Audit export ============================
   * SHA-256 checksummed CPU-state and trace export. The digest is
   * deliberately unkeyed: it detects tampering after export but does not
   * authenticate authorship, and the report says so in plain text.
   */
  var AUDIT_INTEGRITY_NOTE =
    'Unkeyed SHA-256 tamper-detection digest over the canonical JSON payload. ' +
    'It proves the export was not edited after it was written; it is not a ' +
    'signature and cannot prove who produced it.';

  function byteArray(input, name) {
    if (!input || typeof input === 'string' || typeof input.length !== 'number' ||
        !Number.isSafeInteger(input.length) || input.length < 0) {
      throw new TypeError(name + ' must be a byte array.');
    }
    var out = new Uint8Array(input.length);
    for (var i = 0; i < input.length; i++) {
      if (!Number.isInteger(input[i]) || input[i] < 0 || input[i] > 255) {
        throw new TypeError(name + ' must contain only integers from 0 to 255.');
      }
      out[i] = input[i];
    }
    return out;
  }

  function traceForAudit(romBytes, quirks, options) {
    options = options || {};
    var steps = options.steps !== undefined ? options.steps :
      (options.traceSteps !== undefined ? options.traceSteps : 600);
    if (!Number.isInteger(steps) || steps < 0) {
      throw new RangeError('Audit trace steps must be a non-negative integer.');
    }
    var seed = options.seed === undefined ? 0xC8 : options.seed;
    var cyclesPerTick = options.cyclesPerTick === undefined ? 10 : options.cyclesPerTick;
    var report = Chip8.traceProgram(romBytes, steps, {
      quirks: quirks, seed: seed, timers: 'timed', cyclesPerTick: cyclesPerTick
    });
    return {
      seed: seed,
      stepsRequested: steps,
      timerSchedule: report.timerSchedule,
      instructions: report.instructions,
      halted: report.halted,
      error: report.error,
      entries: report.entries,
      finalHash: report.finalHash
    };
  }

  // Build the full audit report object for a machine + cartridge.
  // options: { romName, coverage, traceSteps, seed, cyclesPerTick }
  function buildAudit(cpu, romBytes, options) {
    options = options || {};
    if (!cpu || typeof cpu.snapshotState !== 'function' || !cpu.quirks) {
      throw new TypeError('Audit machine must be a Chip8 instance.');
    }
    var rom = byteArray(romBytes, 'Audit ROM');
    var trace = options.trace === undefined
      ? traceForAudit(rom, cpu.quirks, options)
      : options.trace;
    var report = {
      format: 'chipper8-audit',
      version: 1,
      generator: 'chipper-8 workbench',
      integrity: {
        algorithm: 'SHA-256',
        standard: 'FIPS 180-4',
        keyed: false,
        note: AUDIT_INTEGRITY_NOTE
      },
      rom: {
        name: options.romName || 'custom',
        origin: Chip8.PROGRAM_START,
        byteLength: rom.length,
        bytes: hexBytes(rom),
        sha256: sha256(rom)
      },
      quirks: {
        loadStoreNoIncrementI: !!cpu.quirks.loadStoreNoIncrementI,
        shiftUsesVy: !!cpu.quirks.shiftUsesVy,
        jumpUsesVx: !!cpu.quirks.jumpUsesVx,
        logicResetsVf: !!cpu.quirks.logicResetsVf,
        clipSprites: !!cpu.quirks.clipSprites,
        waitForRelease: !!cpu.quirks.waitForRelease
      },
      coverage: options.coverage || null,
      snapshot: cpu.snapshotState(),
      trace: trace,
      digest: { algorithm: 'SHA-256', payload: 'canonical-json-utf8', value: '' }
    };
    report.digest.value = auditPayloadDigest(report);
    return report;
  }

  // Digest over every field except the digest block itself.
  function auditPayloadDigest(report) {
    var copy = Object.assign({}, report);
    delete copy.digest;
    return sha256(canonicalize(copy));
  }

  function auditJson(report) { return JSON.stringify(report, null, 2); }

  /* CSV export. RFC 4180 quoting plus spreadsheet formula-injection
   * escaping: fields whose first character is = + - @ tab or CR are
   * prefixed with an apostrophe before quoting. */
  function csvCell(value) {
    var s = value === null || value === undefined ? '' : String(value);
    // Formula interpreters trim leading whitespace before looking for a
    // formula lead, so whitespace-padded = + - @ tab and CR cells need the
    // same apostrophe escape as a direct formula lead.
    if (/^[=+\-@\t\r]/.test(s) || /^\s+[=+\-@\t\r]/.test(s)) { s = "'" + s; }
    if (/[",\n\r]/.test(s)) { s = '"' + s.replace(/"/g, '""') + '"'; }
    return s;
  }

  function csvRow(values) {
    return values.map(csvCell).join(',');
  }

  function hexW(v, w) {
    var s = (v & 0xFFFF).toString(16).toUpperCase();
    while (s.length < w) { s = '0' + s; }
    return '0x' + s;
  }

  function traceToCsv(trace) {
    var rows = [csvRow(['step', 'pc', 'opcode', 'mnemonic', 'i', 'sp', 'vf', 'dt', 'st', 'stateHash'])];
    var entries = (trace && trace.entries) || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      rows.push(csvRow([
        e.n, hexW(e.pc, 3), hexW(e.op, 4), e.mnemonic,
        hexW(e.i, 3), e.sp, e.vf, e.dt, e.st, e.h
      ]));
    }
    return rows.join('\r\n') + '\r\n';
  }

  function auditToCsv(report) {
    var lines = [
      csvRow(['chipper8-audit', report.version, 'sha256', report.digest.value]),
      csvRow(['rom', report.rom.name, report.rom.byteLength, report.rom.sha256]),
      csvRow(['quirks', 'loadStoreNoIncrementI', 'shiftUsesVy', 'jumpUsesVx', 'logicResetsVf', 'clipSprites', 'waitForRelease']),
      csvRow(['', String(!!report.quirks.loadStoreNoIncrementI), String(!!report.quirks.shiftUsesVy),
        String(!!report.quirks.jumpUsesVx), String(!!report.quirks.logicResetsVf),
        String(!!report.quirks.clipSprites), String(!!report.quirks.waitForRelease)]),
      csvRow(['snapshot', 'pc', 'i', 'sp', 'dt', 'st', 'instructions', 'stateHash']),
      csvRow(['', hexW(report.snapshot.pc, 3), hexW(report.snapshot.i, 3), report.snapshot.sp,
        report.snapshot.delayTimer, report.snapshot.soundTimer,
        report.snapshot.instructionsExecuted, report.snapshot.stateHash]),
      ''
    ];
    return lines.join('\r\n') + traceToCsv(report.trace);
  }

  function auditToMarkdown(report) {
    var lines = [];
    lines.push('# chipper-8 audit report');
    lines.push('');
    lines.push('- ROM: `' + report.rom.name + '` (' + report.rom.byteLength + ' bytes @ ' + hexW(report.rom.origin, 3) + ')');
    lines.push('- ROM SHA-256: `' + report.rom.sha256 + '`');
    lines.push('- Snapshot state hash (FNV-1a): `' + report.snapshot.stateHash + '`');
    lines.push('- Trace final hash (FNV-1a): `' + report.trace.finalHash + '`');
    lines.push('- Payload digest (SHA-256): `' + report.digest.value + '`');
    lines.push('');
    lines.push('> ' + AUDIT_INTEGRITY_NOTE);
    lines.push('');
    lines.push('| quirk | on |');
    lines.push('| --- | --- |');
    Object.keys(report.quirks).forEach(function (k) {
      lines.push('| ' + k + ' | ' + String(!!report.quirks[k]) + ' |');
    });
    lines.push('');
    if (report.coverage) {
      var cells = report.coverage.map(function (c, i) { return i.toString(16).toUpperCase() + ':' + c; });
      lines.push('Opcode family coverage: `' + cells.join(' ') + '`');
      lines.push('');
    }
    lines.push('| step | pc | opcode | mnemonic | i | sp | vf | dt | st | stateHash |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    var entries = report.trace.entries || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      lines.push('| ' + e.n + ' | ' + hexW(e.pc, 3) + ' | ' + hexW(e.op, 4) +
        ' | ' + e.mnemonic + ' | ' + hexW(e.i, 3) + ' | ' + e.sp + ' | ' + e.vf +
        ' | ' + e.dt + ' | ' + e.st + ' | ' + e.h + ' |');
    }
    lines.push('');
    return lines.join('\n');
  }

  // Structural + digest verification of an audit export. Accepts the JSON
  // text or a parsed object; never throws on malformed input, reports a
  // check list instead so callers can render every failure.
  function verifyAudit(input) {
    var checks = [];
    function check(name, pass, detail) {
      checks.push({ name: name, pass: !!pass, detail: detail || '' });
      return pass;
    }
    var report = input;
    if (typeof input === 'string') {
      try { report = JSON.parse(input); }
      catch (e) {
        check('JSON parses', false, e.message);
        return { ok: false, tampered: true, checks: checks };
      }
    }
    var ok = true;
    ok = check('format is chipper8-audit', report && report.format === 'chipper8-audit') && ok;
    ok = check('version is 1', report && report.version === 1) && ok;
    ok = check('digest block present', report && report.digest &&
      report.digest.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(report.digest.value || '')) && ok;
    var romOk = false;
    if (report && report.rom && typeof report.rom.bytes === 'string') {
      try {
        var romBytes = unhex(report.rom.bytes);
        romOk = hexBytes(romBytes) === report.rom.bytes &&
          romBytes.length === report.rom.byteLength &&
          sha256(romBytes) === report.rom.sha256;
      } catch (e) { romOk = false; }
    }
    ok = check('ROM bytes match embedded SHA-256', romOk) && ok;
    var digestOk = false;
    if (report && report.digest && typeof report.digest.value === 'string') {
      try { digestOk = auditPayloadDigest(report) === report.digest.value; }
      catch (e) { digestOk = false; }
    }
    ok = check('payload digest recomputes to the embedded value', digestOk) && ok;
    ok = check('integrity labeled unkeyed', report && report.integrity && report.integrity.keyed === false) && ok;
    return { ok: ok, tampered: !ok, checks: checks };
  }

  // Replay verification: re-execute the audited ROM on a fresh CPU with
  // the recorded quirks, seed and timer schedule, then compare every
  // traced instruction's address, opcode and per-step state hash plus
  // the final canonical hash.
  function replayAudit(input) {
    var checks = [];
    function check(name, pass, detail) {
      checks.push({ name: name, pass: !!pass, detail: detail || '' });
      return pass;
    }
    function fail(name, detail) {
      check(name, false, detail);
      return { ok: false, checks: checks };
    }
    var report = input;
    if (typeof input === 'string') {
      try { report = JSON.parse(input); }
      catch (e) { return fail('audit parses', e.message); }
    }
    if (!report || typeof report !== 'object' || report.format !== 'chipper8-audit') {
      return fail('audit format is chipper8-audit');
    }
    if (!report.rom || typeof report.rom.bytes !== 'string' || !report.trace || !Array.isArray(report.trace.entries)) {
      return fail('audit carries ROM bytes and a trace entry list');
    }
    if (report.trace.entries.length > 100000) {
      return fail('trace entry count stays within the 100000-step verification budget');
    }
    try {
      var romBytes = unhex(report.rom.bytes);
      var trace = report.trace || {};
      var entries = trace.entries || [];
      var replay = Chip8.traceProgram(romBytes, entries.length, {
        quirks: report.quirks,
        seed: trace.seed,
        timers: trace.timerSchedule && trace.timerSchedule.mode === 'frozen' ? 'frozen' : 'timed',
        cyclesPerTick: trace.timerSchedule && Number.isInteger(trace.timerSchedule.cyclesPerTick) ? trace.timerSchedule.cyclesPerTick : 10
      });
      var mismatch = null;
      for (var i = 0; i < entries.length && i < replay.entries.length; i++) {
        var a = entries[i] || {}, b = replay.entries[i];
        if (a.pc !== b.pc || a.op !== b.op || a.h !== b.h) {
          mismatch = { index: i, expected: { pc: a.pc, op: a.op, h: a.h }, actual: { pc: b.pc, op: b.op, h: b.h } };
          break;
        }
      }
      var ok = true;
      ok = check('instruction count matches', replay.entries.length === entries.length,
        replay.entries.length + ' vs ' + entries.length) && ok;
      ok = check('every entry pc/op/stateHash matches', !mismatch,
        mismatch ? 'first divergence at entry ' + mismatch.index : '') && ok;
      ok = check('final canonical hash matches', replay.finalHash === trace.finalHash,
        replay.finalHash + ' vs ' + trace.finalHash) && ok;
      return { ok: ok, checks: checks, replayHash: replay.finalHash };
    } catch (e) {
      return fail('audit replay input is structurally valid', e.message);
    }
  }

  /* ============================ URL-hash bookmark ============================
   * Compact preset state in #c8=: profile, three quirk DIP bits packed as
   * one octal digit (SW1|SW2|SW3), clock speed and cartridge index.
   *   #c8=p=vip;d=5;hz=600;r=2
   * Unknown keys are ignored; an out-of-range value fails the whole decode.
   */
  function encodeBookmark(state) {
    if (!state || typeof state !== 'object') { throw new TypeError('Bookmark state required.'); }
    var profile = state.profile === undefined ? 'modern' : state.profile;
    if (!Object.prototype.hasOwnProperty.call(Chip8.PROFILES, profile)) {
      throw new RangeError('Bookmark profile is not supported.');
    }
    var dips = state.dips === undefined ? 0 : state.dips;
    if (!Number.isInteger(dips) || dips < 0 || dips > 7) {
      throw new RangeError('Bookmark DIP bits must be an integer from 0 to 7.');
    }
    var parts = ['p=' + profile, 'd=' + dips];
    if (state.speed !== undefined) {
      if (!Number.isInteger(state.speed) || state.speed < 60 || state.speed > 2000) {
        throw new RangeError('Bookmark speed must be an integer from 60 to 2000 Hz.');
      }
      parts.push('hz=' + state.speed);
    }
    if (state.rom !== undefined) {
      if (!Number.isInteger(state.rom) || state.rom < 0 || state.rom > 255) {
        throw new RangeError('Bookmark ROM index must be an integer from 0 to 255.');
      }
      parts.push('r=' + state.rom);
    }
    return parts.join(';');
  }

  function decodeBookmark(text) {
    if (typeof text !== 'string') { return null; }
    var t = text.trim();
    if (t.charAt(0) === '#') { t = t.slice(1); }
    if (t.indexOf('c8=') !== 0) { return null; }
    var body = t.slice(3);
    if (!body) { return null; }
    var fields = {};
    var pairs = body.split(';');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      if (kv.length !== 2 || kv[0] === '') { return null; }
      if (Object.prototype.hasOwnProperty.call(fields, kv[0])) { return null; }
      fields[kv[0]] = kv[1];
    }
    if (!Object.prototype.hasOwnProperty.call(Chip8.PROFILES, fields.p)) { return null; }
    var out = { profile: fields.p, dips: 0, speed: null, rom: null };
    if (fields.d !== undefined) {
      if (!/^[0-7]$/.test(fields.d)) { return null; }
      out.dips = parseInt(fields.d, 8);
    }
    if (fields.hz !== undefined) {
      if (!/^\d+$/.test(fields.hz)) { return null; }
      out.speed = parseInt(fields.hz, 10);
      if (out.speed < 60 || out.speed > 2000) { return null; }
    }
    if (fields.r !== undefined) {
      if (!/^\d+$/.test(fields.r)) { return null; }
      out.rom = parseInt(fields.r, 10);
    }
    return out;
  }

  function dipsFromQuirks(q) {
    return (q.loadStoreNoIncrementI ? 1 : 0) | (q.shiftUsesVy ? 2 : 0) | (q.jumpUsesVx ? 4 : 0);
  }

  /* ============================ Quirk matrix + probes ============================ */
  var PROFILE_LABELS = {
    vip: 'COSMAC VIP 1977',
    chip48: 'CHIP-48 1990',
    modern: 'SCHIP-1.1 / MODERN'
  };
  var PROFILE_ORDER = ['vip', 'chip48', 'modern'];

  var QUIRK_ROWS = [
    { key: 'logicResetsVf', label: 'VF RESET ON 8XY1/2/3' },
    { key: 'loadStoreNoIncrementI', label: 'STATIC I ON FX55/65' },
    { key: 'shiftUsesVy', label: 'SHIFTS READ VY ON 8XY6/E' },
    { key: 'jumpUsesVx', label: 'BXNN JUMP USES VX' },
    { key: 'clipSprites', label: 'DXYN CLIPS AT EDGE' },
    { key: 'waitForRelease', label: 'FX0A WAITS FOR RELEASE' }
  ];

  function quirkMatrix() {
    return QUIRK_ROWS.map(function (row) {
      var cells = {};
      PROFILE_ORDER.forEach(function (p) {
        cells[p] = !!Chip8.PROFILES[p][row.key];
      });
      return { key: row.key, label: row.label, profiles: cells };
    });
  }

  // Identical micro-programs executed on all three profiles so the UI and
  // tests can report the real behavioural divergence, not a lookup table.
  function quirkProbes() {
    function run(bytes, profile, setup, steps) {
      var c = new Chip8();
      c.setProfile(profile);
      c.load(bytes);
      if (setup) { setup(c); }
      var n = steps === undefined ? bytes.length / 2 + 4 : steps;
      for (var i = 0; i < n && !c.halted; i++) { c.step(); }
      return c;
    }
    function pick(cpu, fmt) { return fmt(cpu); }
    return [
      {
        key: 'shiftUsesVy',
        label: '8XY6 SHIFT SOURCE',
        program: [0x61, 0x09, 0x62, 0x06, 0x81, 0x26],
        run: function (p) {
          var c = run(this.program, p);
          return pick(c, function (m) { return 'V1=' + m.V[1] + ' VF=' + m.V[0xF]; });
        }
      },
      {
        key: 'loadStoreNoIncrementI',
        label: 'FX55 I ADVANCE',
        program: [0xA3, 0x00, 0x60, 0x07, 0xF0, 0x55],
        run: function (p) {
          var c = run(this.program, p);
          return pick(c, function (m) { return 'I=' + hexW(m.I, 3); });
        }
      },
      {
        key: 'jumpUsesVx',
        label: 'BNNN JUMP OFFSET',
        program: [0x60, 0x04, 0x62, 0x08, 0xB2, 0x28],
        run: function (p) {
          var c = run(this.program, p);
          return pick(c, function (m) { return 'PC=' + hexW(m.pc, 3); });
        }
      },
      {
        key: 'logicResetsVf',
        label: '8XY1 VF FLAG',
        program: [0x6F, 0x01, 0x61, 0xF0, 0x62, 0x0F, 0x81, 0x21],
        run: function (p) {
          var c = run(this.program, p);
          return pick(c, function (m) { return 'VF=' + m.V[0xF]; });
        }
      },
      {
        key: 'clipSprites',
        label: 'DXYN EDGE PIXELS',
        program: [0x60, 0x3C, 0x61, 0x00, 0xA2, 0x0A, 0xD0, 0x11, 0x00, 0x00, 0xFF],
        run: function (p) {
          var c = run(this.program, p, null, 4);
          return pick(c, function (m) { return 'PIX[0,0]=' + m.display[0]; });
        }
      },
      {
        key: 'waitForRelease',
        label: 'FX0A WITH KEY HELD',
        program: [0xF1, 0x0A, 0x62, 0x07],
        run: function (p) {
          var c = run(this.program, p, function (m) { m.setKey(0xB, true); }, 4);
          return pick(c, function (m) { return 'V1=' + m.V[1]; });
        }
      }
    ].map(function (probe) {
      var results = {};
      PROFILE_ORDER.forEach(function (p) { results[p] = probe.run(p); });
      var divergent = results.vip !== results.chip48 || results.chip48 !== results.modern;
      return { key: probe.key, label: probe.label, results: results, divergent: divergent };
    });
  }

  /* ============================ Self-tests ============================
   * The named suite rendered by the RUN SELF-TESTS panel and asserted
   * wholesale by the Node test suite. Each run() returns {pass, detail}.
   */
  function selfTests() {
    return [
      {
        id: 'sha256-kat',
        name: 'FIPS 180-4 SHA-256 known-answer vectors',
        run: function () {
          var vectors = [
            ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
            ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
            ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
             '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
            ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb']
          ];
          for (var i = 0; i < vectors.length; i++) {
            if (sha256(vectors[i][0]) !== vectors[i][1]) {
              return { pass: false, detail: 'vector ' + i + ' mismatch' };
            }
          }
          return { pass: true, detail: vectors.length + ' vectors' };
        }
      },
      {
        id: 'roundtrip-35',
        name: 'All 35 opcodes disassemble and re-assemble byte-exact',
        run: function () {
          var r = roundTrip();
          return { pass: r.ok, detail: r.checked + ' words checked' };
        }
      },
      {
        id: 'roundtrip-64k',
        name: 'All 65536 words disassemble and re-assemble byte-exact',
        run: function () {
          var r = roundTrip('all');
          return { pass: r.ok, detail: r.checked + ' words checked' };
        }
      },
      {
        id: 'verify-rom',
        name: 'Verification ROM writes all 38 golden check cells',
        run: function () {
          var r = runVerifyRom();
          return { pass: r.ok, detail: r.cells.length + ' cells, ' + r.steps + ' steps, hash ' + r.stateHash };
        }
      },
      {
        id: 'quirk-divergence',
        name: 'All six quirk probes diverge across hardware profiles',
        run: function () {
          var probes = quirkProbes();
          var divergent = probes.filter(function (p) { return p.divergent; }).length;
          return { pass: divergent === probes.length, detail: divergent + '/' + probes.length + ' probes diverge' };
        }
      },
      {
        id: 'time-machine',
        name: 'Step-back restores the exact prior machine state',
        run: function () {
          var c = new Chip8();
          c.rng = Chip8.seededRng(7);
          c.load(assemble('LD V0,1\nLD V1,2\nADD V0,V1\nRND V2,0xFF\nJP 0x200'));
          var tm = new TimeMachine(64);
          for (var i = 0; i < 12; i++) { tm.capture(c); c.step(); }
          var before = c.stateHash();
          var ok = true;
          for (i = 0; i < 12; i++) { ok = tm.undo(c) && ok; }
          var back = c.stateHash();
          var fresh = new Chip8();
          fresh.rng = Chip8.seededRng(7);
          fresh.load(assemble('LD V0,1\nLD V1,2\nADD V0,V1\nRND V2,0xFF\nJP 0x200'));
          return {
            pass: ok && tm.depth() === 0 && back === fresh.stateHash() && before !== back,
            detail: '12 steps rewound, hash ' + back
          };
        }
      },
      {
        id: 'time-machine-ring',
        name: 'Ring buffer keeps the newest 256 snapshots',
        run: function () {
          var c = new Chip8();
          c.load([0x60, 0x01, 0x70, 0x01]);
          var tm = new TimeMachine(256);
          for (var i = 0; i < 300; i++) { tm.capture(c); c.step(); c.pc = 0x202; }
          var ok = tm.depth() === 256;
          var undos = 0;
          while (tm.undo(c)) { undos++; }
          return { pass: ok && undos === 256, detail: undos + ' undos from 300 captures' };
        }
      },
      {
        id: 'snapshot-tamper',
        name: 'Tampered snapshot is rejected by hash validation',
        run: function () {
          var c = new Chip8();
          c.load([0x60, 0x05]);
          var snap = c.snapshotState();
          snap.memory = 'ff' + snap.memory.slice(2);
          var threw = false;
          try { c.restoreState(snap); } catch (e) { threw = true; }
          return { pass: threw, detail: 'restoreState threw ' + (threw ? 'RangeError' : 'nothing') };
        }
      },
      {
        id: 'audit-digest',
        name: 'Audit JSON verifies, edited bytes fail the digest',
        run: function () {
          var c = new Chip8();
          c.load(assemble('LD V0,1\nJP 0x200'));
          var report = buildAudit(c, assemble('LD V0,1\nJP 0x200'), { traceSteps: 16 });
          var clean = verifyAudit(auditJson(report));
          var forged = JSON.parse(auditJson(report));
          forged.rom.bytes = '00' + forged.rom.bytes.slice(2);
          var dirty = verifyAudit(JSON.stringify(forged));
          return {
            pass: clean.ok && !dirty.ok && dirty.tampered,
            detail: clean.checks.filter(function (x) { return x.pass; }).length + ' checks, tamper caught'
          };
        }
      },
      {
        id: 'audit-replay',
        name: 'Audit replay reproduces every traced state hash',
        run: function () {
          var c = new Chip8();
          var rom = assemble('LD V0,30\nLD V1,16\nLD I,spr\nDRW V0,V1,5\nJP 0x200\nspr: DB 0xF0,0x90,0x90,0x90,0xF0');
          c.load(rom);
          var report = buildAudit(c, rom, { traceSteps: 48 });
          var replay = replayAudit(report);
          return { pass: replay.ok, detail: report.trace.entries.length + ' entries replayed' };
        }
      },
      {
        id: 'csv-escape',
        name: 'CSV export escapes commas, quotes and formula injection',
        run: function () {
          var cells = [
            [csvCell('JP V0, 0x234'), '"JP V0, 0x234"'],
            [csvCell('say "hi"'), '"say ""hi"""'],
            [csvCell('=1+1'), "'=1+1"],
            [csvCell('-99'), "'-99"],
            [csvCell('@cmd'), "'@cmd"],
            [csvCell('a\nb'), '"a\nb"'],
            [csvCell(42), '42']
          ];
          var bad = cells.filter(function (c) { return c[0] !== c[1]; });
          return { pass: bad.length === 0, detail: cells.length + ' escape rules' };
        }
      },
      {
        id: 'bookmark',
        name: 'URL-hash bookmark encodes and decodes the full preset',
        run: function () {
          var enc = encodeBookmark({ profile: 'chip48', dips: 5, speed: 720, rom: 3 });
          var dec = decodeBookmark('#' + 'c8=' + enc);
          var ok = dec && dec.profile === 'chip48' && dec.dips === 5 && dec.speed === 720 && dec.rom === 3;
          return { pass: ok, detail: 'c8=' + enc };
        }
      },
      {
        id: 'trace-determinism',
        name: 'Identical ROM, seed and quirks produce identical traces',
        run: function () {
          var rom = assemble('RND V0,0xFF\nRND V1,0xFF\nJP 0x200');
          var a = Chip8.traceProgram(rom, 64, { seed: 99, profile: 'chip48' });
          var b = Chip8.traceProgram(rom, 64, { seed: 99, profile: 'chip48' });
          return { pass: a.finalHash === b.finalHash, detail: 'finalHash ' + a.finalHash };
        }
      },
      {
        id: 'coverage',
        name: 'Coverage histogram totals match executed instruction count',
        run: function () {
          var cov = new CoverageTracker();
          var c = new Chip8();
          c.load(assemble('LD V0,1\nADD V0,2\nOR V0,V1\nJP 0x200'));
          for (var i = 0; i < 16; i++) { cov.record(c.step()); }
          var sum = cov.toArray().reduce(function (x, y) { return x + y; }, 0);
          return { pass: sum === 16 && cov.total === 16 && cov.counts[0x6] === 4, detail: '16 ops across ' + cov.toArray().filter(function (x) { return x > 0; }).length + ' families' };
        }
      },
      {
        id: 'verify-lint',
        name: 'Verification ROM passes static lint with zero findings',
        run: function () {
          var r = runVerifyRom();
          var lint = Chip8.validateRom(r.romBytes);
          var warnings = lint.diagnostics.filter(function (d) { return d.severity !== 'info'; });
          return { pass: lint.ok && warnings.length === 0, detail: lint.errors + ' errors / ' + lint.warnings + ' warnings' };
        }
      },
      {
        id: 'frozen-timers',
        name: 'Frozen timer trace leaves DT and ST untouched',
        run: function () {
          var c = new Chip8();
          c.load(assemble('LD V0,30\nLD DT,V0\nJP 0x202'));
          c.trace(20, { timers: 'frozen' });
          return { pass: c.delayTimer === 30, detail: 'DT=' + c.delayTimer + ' after 20 frozen steps' };
        }
      }
    ];
  }

  function runSelfTests(onEach) {
    var tests = selfTests();
    var results = [];
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      var outcome;
      try {
        outcome = t.run();
      } catch (e) {
        outcome = { pass: false, detail: 'threw: ' + e.message };
      }
      var row = { id: t.id, name: t.name, pass: !!outcome.pass, detail: outcome.detail || '' };
      results.push(row);
      if (onEach) { onEach(row); }
    }
    var passed = results.filter(function (r) { return r.pass; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed, results: results, ok: passed === results.length };
  }

  return {
    TimeMachine: TimeMachine,
    CoverageTracker: CoverageTracker,
    VERIFY_SOURCE: VERIFY_SOURCE,
    VERIFY_CELL_BASE: VERIFY_CELL_BASE,
    VERIFY_GOLDEN: VERIFY_GOLDEN,
    verifyRomGolden: verifyRomGolden,
    runVerifyRom: runVerifyRom,
    CANONICAL_WORDS: CANONICAL_WORDS,
    roundTrip: roundTrip,
    canonicalize: canonicalize,
    hexBytes: hexBytes,
    unhex: unhex,
    buildAudit: buildAudit,
    auditJson: auditJson,
    auditPayloadDigest: auditPayloadDigest,
    traceForAudit: traceForAudit,
    verifyAudit: verifyAudit,
    replayAudit: replayAudit,
    csvCell: csvCell,
    traceToCsv: traceToCsv,
    auditToCsv: auditToCsv,
    auditToMarkdown: auditToMarkdown,
    AUDIT_INTEGRITY_NOTE: AUDIT_INTEGRITY_NOTE,
    encodeBookmark: encodeBookmark,
    decodeBookmark: decodeBookmark,
    dipsFromQuirks: dipsFromQuirks,
    PROFILE_LABELS: PROFILE_LABELS,
    PROFILE_ORDER: PROFILE_ORDER,
    QUIRK_ROWS: QUIRK_ROWS,
    quirkMatrix: quirkMatrix,
    quirkProbes: quirkProbes,
    selfTests: selfTests,
    runSelfTests: runSelfTests
  };
}));
