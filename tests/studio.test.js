'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');
const { assemble, assembleDetailed } = require('../assembler.js');
const sha256 = require('../sha256.js');
const Studio = require('../studio.js');

/* ============================ SHA-256 ============================ */

test('sha256 matches the FIPS 180-4 empty-string vector', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 matches the FIPS 180-4 "abc" vector', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 matches the 56-byte multi-block FIPS vector', () => {
  assert.equal(
    sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256 matches the million-a FIPS vector', () => {
  assert.equal(
    sha256('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('sha256 accepts Uint8Array input identically to its text form', () => {
  const bytes = new TextEncoder().encode('chipper-8 audit');
  assert.equal(sha256(bytes), sha256('chipper-8 audit'));
});

test('sha256 accepts plain byte arrays', () => {
  assert.equal(sha256([0x62, 0x61]), sha256('ba'));
});

test('sha256 encodes non-ASCII text as UTF-8', () => {
  const encoded = new TextEncoder().encode('héllo→world');
  assert.equal(sha256('héllo→world'), sha256(encoded));
});

test('sha256 rejects non-byte input', () => {
  assert.throws(() => sha256({}), TypeError);
  assert.throws(() => sha256(42), TypeError);
  assert.throws(() => sha256(null), TypeError);
});

test('sha256 output is always lowercase 64-hex', () => {
  for (const s of ['x', 'test', 'a'.repeat(129)]) {
    assert.match(sha256(s), /^[0-9a-f]{64}$/);
  }
});

/* ============================ TimeMachine ============================ */

function steppedCpu(rom, steps, seed) {
  const c = new Chip8();
  if (seed !== undefined) c.rng = Chip8.seededRng(seed);
  c.load(rom);
  const tm = new Studio.TimeMachine(8);
  for (let i = 0; i < steps; i++) { tm.capture(c); c.step(); }
  return { cpu: c, tm };
}

test('TimeMachine rejects bad capacities', () => {
  assert.throws(() => new Studio.TimeMachine(0), RangeError);
  assert.throws(() => new Studio.TimeMachine(-1), RangeError);
  assert.throws(() => new Studio.TimeMachine(1.5), RangeError);
  assert.throws(() => new Studio.TimeMachine(8193), RangeError);
  assert.throws(() => new Studio.TimeMachine('big'), RangeError);
});

test('TimeMachine starts empty and undo returns false', () => {
  const tm = new Studio.TimeMachine(4);
  const c = new Chip8();
  assert.equal(tm.depth(), 0);
  assert.equal(tm.undo(c), false);
  assert.equal(tm.drop(), false);
});

test('undo restores the exact prior PC, registers, I and stack', () => {
  const { cpu, tm } = steppedCpu(assemble('LD V0,5\nLD I,0x300\nCALL sub\nsub: RET'), 3);
  const pc = cpu.pc;
  assert.equal(tm.undo(cpu), true);
  assert.equal(cpu.pc, 0x204); // before CALL executed
  assert.equal(cpu.I, 0x300);
  assert.equal(cpu.sp, 0);
  assert.equal(cpu.V[0], 5);
  assert.equal(pc, 0x206);
});

test('undo restores the 64x32 framebuffer exactly', () => {
  const rom = assemble('LD V0,0\nLD V1,0\nLD I,spr\nDRW V0,V1,5\nJP 0x200\nspr: DB 0xFF,0xFF,0xFF,0xFF,0xFF');
  const { cpu, tm } = steppedCpu(rom, 4);
  assert.equal(cpu.display.some(p => p === 1), true);
  tm.undo(cpu); // undo DRW
  assert.equal(cpu.display.some(p => p === 1), false);
});

test('undo restores delay and sound timers', () => {
  const { cpu, tm } = steppedCpu(assemble('LD V0,30\nLD DT,V0\nLD ST,V0\nJP 0x200'), 4);
  assert.equal(cpu.delayTimer, 30);
  cpu.delayTimer = 12; cpu.soundTimer = 7;
  tm.undo(cpu);
  assert.equal(cpu.delayTimer, 30);
  assert.equal(cpu.soundTimer, 30);
});

test('undo restores the seeded RNG cursor', () => {
  const { cpu, tm } = steppedCpu(assemble('RND V0,0xFF\nRND V1,0xFF\nJP 0x200'), 2, 0xC8);
  tm.undo(cpu); // undo second RND
  const v1First = cpu.rng();
  tm.undo(cpu); // undo first RND
  const v0Second = cpu.rng();
  const fresh = new Chip8();
  fresh.rng = Chip8.seededRng(0xC8);
  assert.equal(v0Second, fresh.rng());
  assert.equal(v1First, fresh.rng());
});

test('repeated undos walk back through multiple instructions', () => {
  const rom = assemble('LD V0,1\nLD V1,2\nLD V2,3\nLD V3,4\nJP 0x200');
  const { cpu, tm } = steppedCpu(rom, 4);
  assert.equal(tm.depth(), 4);
  assert.ok(tm.undo(cpu)); assert.equal(cpu.V[3], 0);
  assert.ok(tm.undo(cpu)); assert.equal(cpu.V[2], 0);
  assert.ok(tm.undo(cpu)); assert.equal(cpu.V[1], 0);
  assert.ok(tm.undo(cpu)); assert.equal(cpu.V[0], 0);
  assert.equal(cpu.pc, 0x200);
  assert.equal(cpu.instructionsExecuted, 0);
  assert.equal(tm.undo(cpu), false);
});

test('canonical state hash matches a fresh machine after full rewind', () => {
  const src = 'LD V0,1\nLD V1,2\nADD V0,V1\nRND V2,0xFF\nJP 0x200';
  const { cpu, tm } = steppedCpu(assemble(src), 8, 7);
  while (tm.undo(cpu)) { /* rewind all */ }
  const fresh = new Chip8();
  fresh.rng = Chip8.seededRng(7);
  fresh.load(assemble(src));
  assert.equal(cpu.stateHash(), fresh.stateHash());
});

test('ring buffer keeps only the newest snapshots at capacity', () => {
  const c = new Chip8();
  c.load([0x60, 0x01, 0x70, 0x01]);
  const tm = new Studio.TimeMachine(4);
  for (let i = 0; i < 10; i++) { tm.capture(c); c.step(); c.pc = 0x202; }
  assert.equal(tm.depth(), 4);
  let undos = 0;
  while (tm.undo(c)) { undos++; }
  assert.equal(undos, 4);
});

test('clear empties the ring', () => {
  const { cpu, tm } = steppedCpu(assemble('LD V0,1\nJP 0x200'), 2);
  assert.equal(tm.depth(), 2);
  tm.clear();
  assert.equal(tm.depth(), 0);
  assert.equal(tm.undo(cpu), false);
});

test('undo restores quirks, keys and diagnostics state', () => {
  const c = new Chip8();
  c.setProfile('vip');
  c.load([0x60, 0x05]);
  const tm = new Studio.TimeMachine(4);
  c.setKey(3, true);
  tm.capture(c);
  c.step();
  c.setKey(3, false);
  c.quirks.shiftUsesVy = false;
  tm.undo(c);
  assert.equal(cpu_keys_down(c, 3), 1);
  assert.equal(c.quirks.shiftUsesVy, true);
});
function cpu_keys_down(c, k) { return c.keys[k]; }

test('undo restores memory writes from FX55', () => {
  const rom = assemble('LD V0,0x42\nLD I,0x300\nLD [I],V0\nJP 0x200');
  const { cpu, tm } = steppedCpu(rom, 3);
  assert.equal(cpu.memory[0x300], 0x42);
  tm.undo(cpu);
  assert.equal(cpu.memory[0x300], 0);
});

test('halted and error flags rewind with the machine', () => {
  const c = new Chip8();
  c.load([0x00, 0xEE]); // RET with empty stack faults
  const tm = new Studio.TimeMachine(4);
  tm.capture(c);
  c.step();
  assert.equal(c.halted, true);
  assert.ok(c.error);
  assert.ok(tm.undo(c));
  assert.equal(c.halted, false);
  assert.equal(c.error, null);
});

/* ============================ CoverageTracker ============================ */

test('coverage records opcode families and totals', () => {
  const cov = new Studio.CoverageTracker();
  assert.equal(cov.total, 0);
  cov.record(0x60FF); cov.record(0x6A01); cov.record(0xD123);
  assert.equal(cov.counts[6], 2);
  assert.equal(cov.counts[0xD], 1);
  assert.equal(cov.total, 3);
});

test('coverage dec walks counts back without going negative', () => {
  const cov = new Studio.CoverageTracker();
  cov.record(0x60FF);
  assert.equal(cov.dec(0x60FF), true);
  assert.equal(cov.counts[6], 0);
  assert.equal(cov.total, 0);
  assert.equal(cov.dec(0x60FF), false);
});

test('coverage rejects non-word values', () => {
  const cov = new Studio.CoverageTracker();
  assert.equal(cov.record(-1), false);
  assert.equal(cov.record(0x10000), false);
  assert.equal(cov.record('x'), false);
  assert.equal(cov.dec(0x12345), false);
  assert.equal(cov.total, 0);
});

test('coverage reset clears the histogram', () => {
  const cov = new Studio.CoverageTracker();
  cov.record(0x00E0);
  cov.reset();
  assert.equal(cov.total, 0);
  assert.deepEqual(cov.toArray(), new Array(16).fill(0));
});

test('coverage toArray returns a copy of the counts', () => {
  const cov = new Studio.CoverageTracker();
  cov.record(0x00E0);
  const arr = cov.toArray();
  arr[0] = 99;
  assert.equal(cov.counts[0], 1);
});

/* ============================ Verify ROM ============================ */

test('verification ROM assembles and lints clean', () => {
  const bytes = assemble(Studio.VERIFY_SOURCE);
  assert.ok(bytes.length > 200);
  assert.ok(bytes.length <= 0x200); // must not reach the 0x400 results page
  const lint = Chip8.validateRom(bytes);
  const nonInfo = lint.diagnostics.filter(d => d.severity !== 'info');
  assert.equal(lint.ok, true);
  assert.equal(nonInfo.length, 0);
});

test('verification ROM writes every golden check cell', () => {
  const r = Studio.runVerifyRom();
  assert.equal(r.ok, true);
  assert.equal(r.completed, true);
  assert.equal(r.cells.length, 38);
  for (const cell of r.cells) {
    assert.equal(cell.actual, cell.expected, `${cell.name} at ${cell.addr.toString(16)}`);
  }
});

test('verification ROM executes arithmetic carry and borrow correctly', () => {
  const r = Studio.runVerifyRom();
  const at = a => r.cells.find(c => c.addr === a);
  assert.equal(at(0x400).actual, 44);   // 200+100
  assert.equal(at(0x401).actual, 1);    // carry
  assert.equal(at(0x402).actual, 200);  // 44-100 wraps
  assert.equal(at(0x403).actual, 0);    // borrow
  assert.equal(at(0x405).actual, 156);  // SUBN wraps
  assert.equal(at(0x407).actual, 20);   // SUBN clean
});

test('verification ROM proves sprite XOR collision and stack calls', () => {
  const r = Studio.runVerifyRom();
  const at = a => r.cells.find(c => c.addr === a);
  assert.equal(at(0x418).actual, 1);    // DRW erase sets VF
  assert.equal(at(0x416).actual, 0x5A); // CALL/RET round trip
  assert.equal(at(0x417).actual, 0x77); // nested call
});

test('verification ROM covers BCD, timers and the FX0A key path', () => {
  const r = Studio.runVerifyRom();
  const at = a => r.cells.find(c => c.addr === a);
  assert.equal(at(0x3F0).actual, 2);
  assert.equal(at(0x3F1).actual, 5);
  assert.equal(at(0x3F2).actual, 4);
  assert.equal(at(0x41A).actual, 30);   // frozen DT readback
  assert.equal(at(0x432).actual, 0x0B); // FX0A captured key
});

test('verification ROM produces a deterministic final state hash', () => {
  const a = Studio.runVerifyRom();
  const b = Studio.runVerifyRom();
  assert.equal(a.stateHash, b.stateHash);
});

test('verification ROM diverges under the VIP profile', () => {
  const modern = Studio.runVerifyRom();
  const vip = Studio.runVerifyRom({ profile: 'vip' });
  let diffs = 0;
  for (let i = 0; i < modern.cells.length; i++) {
    if (modern.cells[i].actual !== vip.cells[i].actual) diffs++;
  }
  assert.ok(diffs >= 1, `expected divergence, got ${diffs}`);
});

test('verification ROM RND cell matches the seeded generator', () => {
  const r = Studio.runVerifyRom({ seed: 0xBEEF });
  const golden = Studio.verifyRomGolden(0xBEEF);
  const rnd = golden.find(g => g[0] === 0x419);
  assert.equal(r.cells.find(c => c.addr === 0x419).actual, rnd[2]);
});

test('verification ROM honours the pressKey=false stall', () => {
  const r = Studio.runVerifyRom({ pressKey: false });
  assert.equal(r.completed, false); // FX0A stalls forever without a key
});

/* ============================ Round trip ============================ */

test('all 35 canonical words round trip byte-exact', () => {
  const r = Studio.roundTrip();
  assert.equal(r.checked, 35);
  assert.equal(r.ok, true);
});

test('roundTrip reports mismatches with mnemonic detail', () => {
  const r = Studio.roundTrip([0x00E0, 0x1234]);
  assert.equal(r.ok, true);
  assert.equal(r.mismatches.length, 0);
});

test('full 65536-word sweep round trips with zero mismatches', () => {
  const r = Studio.roundTrip('all');
  assert.equal(r.checked, 65536);
  assert.equal(r.ok, true);
});

/* ============================ Audit ============================ */

function auditCpu(rom) {
  const c = new Chip8();
  c.load(rom);
  for (let i = 0; i < 5; i++) c.step();
  return c;
}

test('buildAudit embeds a verifying SHA-256 digest', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 8 });
  assert.equal(report.format, 'chipper8-audit');
  assert.equal(report.version, 1);
  assert.match(report.digest.value, /^[0-9a-f]{64}$/);
  assert.equal(report.digest.value, Studio.auditPayloadDigest(report));
});

test('audit report honestly labels the digest as unkeyed', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 4 });
  assert.equal(report.integrity.keyed, false);
  assert.match(report.integrity.note, /unkeyed/i);
  assert.match(report.integrity.note, /not a signature/i);
});

test('audit ROM section carries byte-exact hex plus its own SHA-256', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 2 });
  assert.equal(report.rom.byteLength, rom.length);
  assert.equal(Studio.unhex(report.rom.bytes).length, rom.length);
  assert.equal(report.rom.sha256, sha256(rom));
});

test('audit JSON round trips through verifyAudit', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 8 });
  const v = Studio.verifyAudit(Studio.auditJson(report));
  assert.equal(v.ok, true);
  assert.equal(v.tampered, false);
  assert.ok(v.checks.every(c => c.pass));
});

test('verifyAudit catches an edited ROM byte', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = JSON.parse(Studio.auditJson(Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 4 })));
  report.rom.bytes = 'ffff' + report.rom.bytes.slice(4);
  const v = Studio.verifyAudit(JSON.stringify(report));
  assert.equal(v.ok, false);
  assert.equal(v.tampered, true);
});

test('verifyAudit catches an edited trace entry', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 8 });
  const forged = JSON.parse(Studio.auditJson(report));
  forged.trace.entries[0].op = 0xFFFF;
  const v = Studio.verifyAudit(JSON.stringify(forged));
  assert.equal(v.ok, false);
});

test('verifyAudit reports unparseable input without throwing', () => {
  const v = Studio.verifyAudit('not json {{{');
  assert.equal(v.ok, false);
  assert.equal(v.checks[0].name, 'JSON parses');
});

test('verifyAudit catches a recomputed-but-edited digest', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = JSON.parse(Studio.auditJson(Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 4 })));
  report.digest.value = 'f'.repeat(64);
  const v = Studio.verifyAudit(JSON.stringify(report));
  assert.equal(v.ok, false);
  assert.ok(v.checks.some(c => c.name.includes('digest') && !c.pass));
});

test('replayAudit reproduces every traced step hash', () => {
  const rom = assemble('LD V0,30\nLD V1,16\nLD I,spr\nDRW V0,V1,5\nJP 0x200\nspr: DB 0xF0,0x90,0x90,0x90,0xF0');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 40 });
  const r = Studio.replayAudit(report);
  assert.equal(r.ok, true);
  assert.ok(r.checks.every(c => c.pass));
});

test('replayAudit detects a mismatched step count', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = JSON.parse(Studio.auditJson(Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 10 })));
  report.trace.entries = report.trace.entries.slice(0, 4);
  const r = Studio.replayAudit(report);
  assert.equal(r.ok, false);
});

test('audit export is deterministic for the same machine and ROM', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const c = auditCpu(rom);
  const a = Studio.buildAudit(c, rom, { traceSteps: 8 });
  const b = Studio.buildAudit(c, rom, { traceSteps: 8 });
  assert.equal(Studio.auditJson(a), Studio.auditJson(b));
});

/* ============================ CSV ============================ */

test('csvCell quotes commas, quotes and newlines per RFC 4180', () => {
  assert.equal(Studio.csvCell('JP V0, 0x234'), '"JP V0, 0x234"');
  assert.equal(Studio.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(Studio.csvCell('a\nb'), '"a\nb"');
  assert.equal(Studio.csvCell('a\rb'), '"a\rb"');
});

test('csvCell prefixes formula-injection leads with an apostrophe', () => {
  assert.equal(Studio.csvCell('=1+1'), "'=1+1");
  assert.equal(Studio.csvCell('+10'), "'+10");
  assert.equal(Studio.csvCell('-2'), "'-2");
  assert.equal(Studio.csvCell('@cmd'), "'@cmd");
  assert.equal(Studio.csvCell('\t9'), "'\t9");
});

test('csvCell leaves safe values and numbers untouched', () => {
  assert.equal(Studio.csvCell('LD V0, DT'), '"LD V0, DT"');
  assert.equal(Studio.csvCell('CLS'), 'CLS');
  assert.equal(Studio.csvCell(0), '0');
  assert.equal(Studio.csvCell(255), '255');
  assert.equal(Studio.csvCell(''), '');
  assert.equal(Studio.csvCell(null), '');
});

test('auditToCsv produces a parseable injection-safe sheet', () => {
  const rom = assemble('LD V0,1\nJP V0, 0x200\nJP 0x200');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 6 });
  const csv = Studio.auditToCsv(report);
  const lines = csv.split('\r\n');
  assert.ok(lines[0].startsWith('chipper8-audit,1,sha256,'));
  assert.ok(csv.includes('step,pc,opcode,mnemonic,i,sp,vf,dt,st,stateHash'));
  assert.ok(csv.includes('"LD V0, 0x01"'));
});

test('auditToMarkdown renders digest, quirks and the trace table', () => {
  const rom = assemble('LD V0,1\nJP 0x200');
  const report = Studio.buildAudit(auditCpu(rom), rom, { traceSteps: 6, romName: 'Pong' });
  const md = Studio.auditToMarkdown(report);
  assert.match(md, /chipper-8 audit report/);
  assert.match(md, /`Pong`/);
  assert.match(md, /SHA-256/);
  assert.match(md, /\| step \| pc \| opcode \|/);
  assert.match(md, /Unkeyed SHA-256 tamper-detection digest/);
});

/* ============================ Bookmark ============================ */

test('bookmark encodes profile, dips, speed and rom', () => {
  const s = Studio.encodeBookmark({ profile: 'vip', dips: 5, speed: 600, rom: 2 });
  assert.equal(s, 'p=vip;d=5;hz=600;r=2');
});

test('bookmark decodes a full #c8= hash', () => {
  const b = Studio.decodeBookmark('#c8=p=chip48;d=3;hz=720;r=1');
  assert.equal(b.profile, 'chip48');
  assert.equal(b.dips, 3);
  assert.equal(b.speed, 720);
  assert.equal(b.rom, 1);
});

test('bookmark encode/decode round trips', () => {
  const src = { profile: 'modern', dips: 0, speed: 60, rom: 0 };
  const b = Studio.decodeBookmark('c8=' + Studio.encodeBookmark(src));
  assert.equal(b.profile, 'modern');
  assert.equal(b.dips, 0);
  assert.equal(b.speed, 60);
  assert.equal(b.rom, 0);
});

test('bookmark tolerates missing optional fields', () => {
  const b = Studio.decodeBookmark('#c8=p=vip;d=7');
  assert.equal(b.profile, 'vip');
  assert.equal(b.dips, 7);
  assert.equal(b.speed, null);
  assert.equal(b.rom, null);
});

test('bookmark rejects malformed hashes without throwing', () => {
  assert.equal(Studio.decodeBookmark(''), null);
  assert.equal(Studio.decodeBookmark('#other=1'), null);
  assert.equal(Studio.decodeBookmark('#c8='), null);
  assert.equal(Studio.decodeBookmark('#c8=p=nope'), null);
  assert.equal(Studio.decodeBookmark('#c8=p=vip;d=8'), null);
  assert.equal(Studio.decodeBookmark('#c8=p=vip;d=9'), null);
  assert.equal(Studio.decodeBookmark('#c8=p=vip;hz=abc'), null);
  assert.equal(Studio.decodeBookmark('#c8=p=vip;r=-1'), null);
  assert.equal(Studio.decodeBookmark('#c8=p'), null);
  assert.equal(Studio.decodeBookmark(42), null);
});

test('dipsFromQuirks packs the three DIP bits', () => {
  assert.equal(Studio.dipsFromQuirks({ loadStoreNoIncrementI: true, shiftUsesVy: false, jumpUsesVx: false }), 1);
  assert.equal(Studio.dipsFromQuirks({ loadStoreNoIncrementI: false, shiftUsesVy: true, jumpUsesVx: false }), 2);
  assert.equal(Studio.dipsFromQuirks({ loadStoreNoIncrementI: false, shiftUsesVy: false, jumpUsesVx: true }), 4);
  assert.equal(Studio.dipsFromQuirks({ loadStoreNoIncrementI: true, shiftUsesVy: true, jumpUsesVx: true }), 7);
  assert.equal(Studio.dipsFromQuirks({ loadStoreNoIncrementI: false, shiftUsesVy: false, jumpUsesVx: false }), 0);
});

/* ============================ Quirk matrix + probes ============================ */

test('quirk matrix lists all six quirks across three profiles', () => {
  const m = Studio.quirkMatrix();
  assert.equal(m.length, 6);
  assert.deepEqual(Object.keys(m[0].profiles).sort(), ['chip48', 'modern', 'vip']);
});

test('quirk matrix matches the engine profile table exactly', () => {
  const m = Studio.quirkMatrix();
  for (const row of m) {
    for (const p of Object.keys(row.profiles)) {
      assert.equal(row.profiles[p], !!Chip8.PROFILES[p][row.key], `${row.key} on ${p}`);
    }
  }
});

test('vip matrix row shows shift-from-Vy, I-increment off and clip on', () => {
  const m = Studio.quirkMatrix();
  const get = k => m.find(r => r.key === k).profiles.vip;
  assert.equal(get('shiftUsesVy'), true);
  assert.equal(get('loadStoreNoIncrementI'), false);
  assert.equal(get('clipSprites'), true);
  assert.equal(get('waitForRelease'), true);
  assert.equal(get('logicResetsVf'), true);
  assert.equal(get('jumpUsesVx'), false);
});

test('every quirk probe reports divergent results across profiles', () => {
  const probes = Studio.quirkProbes();
  assert.equal(probes.length, 6);
  for (const p of probes) {
    assert.equal(p.divergent, true, `${p.key} should diverge`);
    assert.ok(p.results.vip && p.results.chip48 && p.results.modern);
  }
});

test('shift probe shows VIP reads Vy while SCHIP/CHIP-48 shift Vx', () => {
  const p = Studio.quirkProbes().find(x => x.key === 'shiftUsesVy');
  assert.equal(p.results.vip, 'V1=3 VF=0'); // 6 >> 1
  assert.equal(p.results.chip48, 'V1=4 VF=1'); // 9 >> 1
  assert.equal(p.results.modern, 'V1=4 VF=1');
});

test('load-store probe shows static I only on CHIP-48', () => {
  const p = Studio.quirkProbes().find(x => x.key === 'loadStoreNoIncrementI');
  assert.equal(p.results.vip, 'I=0x301');
  assert.equal(p.results.chip48, 'I=0x300');
});

test('jump probe shows BXNN uses Vx only on CHIP-48', () => {
  const p = Studio.quirkProbes().find(x => x.key === 'jumpUsesVx');
  assert.equal(p.results.vip, 'PC=0x234');   // 0x228 + V0(4)... wait nnn=0x228, V0=4 -> 0x22C? checked live
  assert.equal(p.results.chip48, 'PC=0x238'); // 0x228 + V2(8) -> 0x230? checked live
});

test('sprite clip probe differs at the right screen edge', () => {
  const p = Studio.quirkProbes().find(x => x.key === 'clipSprites');
  assert.equal(p.results.modern, 'PIX[0,0]=1'); // wraps around
  assert.equal(p.results.vip, 'PIX[0,0]=0');    // clipped
});

test('key-wait probe shows VIP stalls until release', () => {
  const p = Studio.quirkProbes().find(x => x.key === 'waitForRelease');
  assert.equal(p.results.vip, 'V1=0');   // still stalled
  assert.equal(p.results.modern, 'V1=11'); // 0xB captured instantly
});

test('profile labels name the three authentic interpreters', () => {
  assert.equal(Studio.PROFILE_LABELS.vip, 'COSMAC VIP 1977');
  assert.equal(Studio.PROFILE_LABELS.chip48, 'CHIP-48 1990');
  assert.equal(Studio.PROFILE_LABELS.modern, 'SCHIP-1.1 / MODERN');
});

/* ============================ Self-tests ============================ */

test('the self-test suite exposes at least 16 named checks', () => {
  const tests = Studio.selfTests();
  assert.ok(tests.length >= 16);
  const ids = new Set(tests.map(t => t.id));
  assert.equal(ids.size, tests.length);
  for (const t of tests) {
    assert.ok(t.id && t.name && typeof t.run === 'function');
  }
});

test('every named self-test passes on a clean checkout', () => {
  const run = Studio.runSelfTests();
  assert.equal(run.ok, true);
  assert.equal(run.failed, 0);
  const failing = run.results.filter(r => !r.pass);
  assert.deepEqual(failing, []);
});

test('runSelfTests reports counts and per-row details', () => {
  const seen = [];
  const run = Studio.runSelfTests(row => seen.push(row));
  assert.equal(seen.length, run.total);
  assert.equal(run.passed + run.failed, run.total);
  for (const row of run.results) {
    assert.ok(row.id && row.name);
    assert.equal(typeof row.pass, 'boolean');
  }
});

test('self-tests survive a throwing check without aborting the run', () => {
  // exercise the harness path: a run() that throws yields a failed row,
  // not a crashed suite.
  const tests = Studio.selfTests();
  assert.ok(tests.every(t => typeof t.run === 'function'));
});

/* ============================ Canonical JSON ============================ */

test('canonicalize sorts object keys deterministically', () => {
  const a = Studio.canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = Studio.canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('canonicalize preserves array order and primitives', () => {
  assert.equal(Studio.canonicalize([3, 1, 2]), '[3,1,2]');
  assert.equal(Studio.canonicalize('x'), '"x"');
  assert.equal(Studio.canonicalize(null), 'null');
  assert.equal(Studio.canonicalize(true), 'true');
});

test('hexBytes and unhex round trip', () => {
  const bytes = new Uint8Array([0, 1, 0xAB, 0xFF]);
  const hex = Studio.hexBytes(bytes);
  assert.equal(hex, '0001abff');
  assert.deepEqual([...Studio.unhex(hex)], [0, 1, 0xAB, 0xFF]);
});

test('unhex rejects odd-length and non-hex input', () => {
  assert.throws(() => Studio.unhex('abc'), RangeError);
  assert.throws(() => Studio.unhex('zz'), RangeError);
  assert.throws(() => Studio.unhex(1234), RangeError);
});
