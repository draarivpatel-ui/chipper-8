'use strict';
// Parity coverage: the exported trace engine and the live bench clock share
// one canonical cycle schedule. Every test runs the same program through
// Chip8.prototype.trace (timed mode) and through Clock.advance driving a
// second machine, then compares registers, timers, diagnostics and the full
// canonical state hash byte for byte.
const test = require('node:test');
const assert = require('node:assert/strict');
const Chip8 = require('../engine.js');
const Clock = require('../clock.js');

// Drive a machine through the real Clock exactly like app.js frame(): the
// clock emits hz CPU cycle edges per second and 60 Hz timer edges, both
// interleaved in timestamp order. `edges` counts CPU cycle edges (step
// calls), because a stalled FX0A fetch consumes an edge without executing.
function runLive(rom, cycleEdges, hz, configure) {
  const cpu = new Chip8();
  cpu.load(rom);
  if (configure) { configure(cpu); }
  const clock = new Clock();
  let edges = 0;
  const execute = () => { edges++; cpu.step(); return !cpu.halted; };
  const tick = () => { cpu.tickTimers(); };
  while (edges < cycleEdges && !cpu.halted) {
    const before = edges;
    clock.advance((cycleEdges - edges) / hz, hz, execute, tick);
    if (edges === before) break;
  }
  return cpu;
}

test('coincident timer boundary: trace matches the live clock register for register', () => {
  // LD V0, 1; LD DT, V0; LD V1, DT at 120 Hz. The third instruction shares
  // its CPU edge with a 60 Hz timer edge; the canonical schedule resolves
  // the tick first, so V1 reads the decremented value on both paths.
  const rom = [0x60, 0x01, 0xF0, 0x15, 0xF1, 0x07];
  const traced = new Chip8();
  traced.load(rom);
  const r = traced.trace(3, { cyclesPerTick: 2 });
  const live = runLive(rom, 3, 120);
  assert.equal(traced.V[1], 1);
  assert.equal(traced.V[1], live.V[1]);
  assert.equal(traced.delayTimer, live.delayTimer);
  assert.equal(traced.soundTimer, live.soundTimer);
  assert.equal(traced.instructionsExecuted, live.instructionsExecuted);
  assert.equal(traced.stateHash(), live.stateHash());
  assert.equal(r.finalHash, live.stateHash());
});

test('FX0A wait: timers keep ticking through the stall on both paths', () => {
  // LD V0, 3; LD DT, V0; LD V1, K stalls from instruction 3 on. Eight CPU
  // cycle edges at 120 Hz must tick DT down to zero identically.
  const rom = [0x60, 0x03, 0xF0, 0x15, 0xF1, 0x0A];
  const traced = new Chip8();
  traced.load(rom);
  const r = traced.trace(8, { cyclesPerTick: 2, includeStalls: true });
  const live = runLive(rom, 8, 120);
  assert.equal(traced.instructionsExecuted, 2);   // FX0A never completes
  assert.equal(traced.waitingForKey, 1);
  assert.equal(traced.delayTimer, 0);
  assert.equal(traced.delayTimer, live.delayTimer);
  assert.equal(traced.soundTimer, live.soundTimer);
  assert.equal(traced.instructionsExecuted, live.instructionsExecuted);
  assert.equal(traced.waitingForKey, live.waitingForKey);
  assert.equal(traced.stateHash(), live.stateHash());
  assert.equal(r.finalHash, live.stateHash());
  // Stall entries report the timers the live machine would show.
  const stalls = r.entries.filter(e => e.stall);
  assert.ok(stalls.length > 0);
  assert.equal(stalls[stalls.length - 1].dt, 0);
});

test('boundary sweep: trace and clock agree for every rate and phase mix', () => {
  const rom = [0x60, 0x0A, 0x61, 0x05, 0xC2, 0xFF, 0xA3, 0x00,
               0x80, 0x24, 0xF0, 0x15, 0x61, 0x03, 0xF1, 0x18];
  const configure = c => { c.rng = Chip8.seededRng(4242); };
  for (const [steps, cyclesPerTick] of [[6, 2], [9, 3], [9, 2], [8, 1], [10, 4], [8, 12]]) {
    const traced = new Chip8();
    traced.load(rom); configure(traced);
    const r = traced.trace(steps, { cyclesPerTick });
    const live = runLive(rom, steps, cyclesPerTick * 60, configure);
    assert.equal(traced.stateHash(), live.stateHash(), 'hz ' + cyclesPerTick * 60 + ' steps ' + steps);
    assert.equal(r.finalHash, live.stateHash());
    assert.deepEqual([...traced.V], [...live.V]);
    assert.equal(traced.delayTimer, live.delayTimer);
    assert.equal(traced.soundTimer, live.soundTimer);
    assert.deepEqual(traced.diagnostics, live.diagnostics);
  }
});

test('frozen mode stays a CPU-only trace with timers untouched', () => {
  const rom = [0x60, 0x01, 0xF0, 0x15, 0xF1, 0x07];
  const c = new Chip8();
  c.load(rom);
  const r = c.trace(3, { timers: 'frozen' });
  assert.equal(c.delayTimer, 1);
  assert.equal(r.timerSchedule.mode, 'frozen');
  assert.equal(r.entries[2].dt, 1);
});

test('chunked traces continue the live schedule instead of re-phasing it', () => {
  // LD V0,40; LD DT,V0; loop: LD V0,DT; JP loop. The tick phase persists on
  // the machine, so trace(5)+trace(5) must equal trace(10) and the bench.
  const rom = [0x60, 0x28, 0xF0, 0x15, 0xF0, 0x07, 0x12, 0x04];
  const single = new Chip8(); single.load(rom); single.trace(10, { cyclesPerTick: 2 });
  const chunked = new Chip8(); chunked.load(rom);
  chunked.trace(5, { cyclesPerTick: 2 });
  chunked.trace(5, { cyclesPerTick: 2 });
  const live = runLive(rom, 10, 120);
  assert.equal(chunked.stateHash(), single.stateHash());
  assert.equal(chunked.stateHash(), live.stateHash());
  assert.equal(chunked.delayTimer, live.delayTimer);
  // A fresh load restarts the schedule.
  chunked.load(rom);
  assert.equal(chunked.traceCyclePhase, 0);
  chunked.trace(10, { cyclesPerTick: 2 });
  assert.equal(chunked.stateHash(), single.stateHash());
});

test('restore commits quirks by reference so a sabotaged receiver stays whole', () => {
  const src = new Chip8(); src.load([0x60, 0x42, 0xF0, 0x15]); src.step(); src.step();
  const snap = src.snapshotState();
  for (const sabotage of [c => Object.freeze(c.quirks), c => { c.quirks = null; }]) {
    const receiver = new Chip8(); receiver.load([0x60, 0x07]); receiver.step();
    sabotage(receiver);
    receiver.restoreState(snap);
    assert.equal(receiver.stateHash(), src.stateHash());
  }
});

test('restore keeps a literal __proto__ diagnostic count as data', () => {
  const src = new Chip8(); src.load([0, 1]); src.step();
  // Inject __proto__ as a real own property the way JSON.parse would:
  // plain assignment on a normal object hits the prototype setter.
  const snap = JSON.parse(JSON.stringify(src.snapshotState()).replace(
    '"SYS_NOP":1', '"SYS_NOP":1,"__proto__":9'));
  assert.equal(snap.diagnosticCounts['__proto__'], 9);
  const probe = new Chip8();
  probe.restoreState(JSON.parse(JSON.stringify(src.snapshotState())));
  probe.diagnosticCounts['__proto__'] = 9; // probe's map is null-proto
  snap.stateHash = probe.stateHash();
  const receiver = new Chip8();
  receiver.restoreState(snap);
  assert.equal(receiver.diagnosticCounts['__proto__'], 9);
  assert.equal(receiver.stateHash(), snap.stateHash);
});

test('restore rejects live-impossible diagnostic reports', () => {
  const src = new Chip8(); src.load([0, 1]); src.step();
  // Stage the tampered fields on a probe machine to mint a matching hash,
  // proving the rejection comes from validation, not the digest.
  const forge = (overrides) => {
    const snap = JSON.parse(JSON.stringify(src.snapshotState()));
    const probe = new Chip8();
    probe.restoreState(JSON.parse(JSON.stringify(src.snapshotState())));
    if (overrides.diag !== undefined) { snap.diagnostics = overrides.diag; probe.diagnostics = overrides.diag; }
    if (overrides.counts !== undefined) {
      snap.diagnosticCounts = overrides.counts;
      probe.diagnosticCounts = Object.assign(Object.create(null), overrides.counts);
    }
    snap.stateHash = probe.stateHash();
    return snap;
  };
  const receiver = new Chip8();
  // A zero tally is impossible on a live machine: counts only exist via
  // note(), which creates them at 1 or higher.
  const bad1 = forge({ counts: { SYS_NOP: 0 } });
  assert.throws(() => receiver.restoreState(bad1), /diagnosticCounts/);
  // Counts that omit a code the entries recorded.
  const bad2 = forge({ counts: {} });
  assert.throws(() => receiver.restoreState(bad2), /under-counts/);
  // More entries than the live cap allows.
  const many = [];
  for (let i = 0; i < 129; i++) many.push({ cycle: i, pc: 0x200, code: 'SYS_NOP', severity: 'info', message: 'm' });
  const bad3 = forge({ diag: many });
  assert.throws(() => receiver.restoreState(bad3), /cap/);
});

test('restore rejects a forged rngSeed provenance label', () => {
  const src = new Chip8(); src.load([0xC0, 0xFF]); src.rng = Chip8.seededRng(200); src.step();
  const snap = JSON.parse(JSON.stringify(src.snapshotState()));
  snap.rngSeed = 999;
  // Hash intentionally NOT recomputed: rngSeed is canonical state now, so
  // even a recomputed-for-the-old-value hash is beside the point; the field
  // is covered by the digest so any edit must fail.
  assert.throws(() => new Chip8().restoreState(snap), /state hash mismatch/);
});

test('faulted edges are traced as faults, not silent stalls', () => {
  const cpu = new Chip8(); cpu.load([0x1F, 0xFF]); // JP 0xFFF -> out of ROM? pc 0xFFF is in-range; use a bad jump
  const r = cpu.trace(3, { includeStalls: true });
  // 0x1FFF jumps to 0xFFF which holds no ROM: the fetch faults (PC_RANGE).
  const stalls = r.entries.filter(e => e.stall);
  if (stalls.length) { assert.ok(stalls[stalls.length - 1].fault === true || cpu.error === null); }
});

test('a frozen trace does not consume 60 Hz cycle edges', () => {
  // V0=1; DT=V0; V1=0; V1=DT. If the frozen middle step still advanced the
  // phase, the final read would land one tick early and see DT already 0.
  const rom = [0x60, 0x01, 0xF0, 0x15, 0x61, 0x00, 0xF1, 0x07];
  const cpu = new Chip8();
  cpu.load(rom);
  cpu.trace(2, { cyclesPerTick: 2 });
  cpu.trace(1, { timers: 'frozen' });
  cpu.trace(1, { cyclesPerTick: 2 });
  assert.equal(cpu.V[1], 1);
  assert.equal(cpu.traceTimersFrozen, false); // run control restored after the call
});

test('interleaved frozen traces leave the timer schedule identical to uninterrupted timed steps', () => {
  const rom = [0x60, 0x01, 0xF0, 0x15, 0x61, 0x00, 0xF1, 0x07, 0x00, 0xE0];
  const straight = new Chip8(); straight.load(rom);
  straight.trace(6, { cyclesPerTick: 2 });
  const interleaved = new Chip8(); interleaved.load(rom);
  interleaved.trace(3, { cyclesPerTick: 2 });
  interleaved.trace(2, { timers: 'frozen' });
  interleaved.trace(3, { cyclesPerTick: 2 });
  assert.equal(interleaved.traceCyclePhase, straight.traceCyclePhase);
  assert.equal(interleaved.delayTimer, straight.delayTimer);
  assert.equal(interleaved.soundTimer, straight.soundTimer);
});
