# Chipper-8

A zero-dependency CHIP-8 virtual machine, two-pass assembler, and 1977 RCA COSMAC VIP hardware workbench that runs in the browser and in Node.js. It includes four original games written in CHIP-8 assembly, compiled into bytecode at page load, paired with an instruction-level trace, a 16-byte RAM window around the program counter, and hardware DIP switches for historical interpreter quirks. The workbench doubles as a computer-architecture studio: a 256-step exact-undo time machine, a quirk-profile compatibility matrix with live divergence probes, an opcode-family coverage heatmap, SHA-256 checksummed audit exports, URL-hash preset bookmarks, and an in-page self-test suite.

[Launch the live workbench](https://aariv.me/chipper-8/)

## Architecture & Hardware Specifications

- **Complete 1977 COSMAC VIP VM (`engine.js`)**: All 35 classic instructions, 4096 bytes of flat RAM (`0x000..0xFFF` with built-in hex font sprites at `0x000..0x04F` and cartridge ROM space starting at `0x200`), a 64x32 monochrome XOR framebuffer (`DXYN` with collision latch in `VF`), sixteen 8-bit general registers (`V0..VF`), a 16-level subroutine stack, a 12-bit index register (`I`), and 60 Hz delay and sound timers.
- **Two-Pass Symbolic Assembler (`assembler.js`)**: Pass 1 strips `;` and `//` comments, tracks byte offsets from `0x200`, and builds the symbol table for forward and backward labels. Pass 2 resolves label addresses and emits big-endian 16-bit opcodes plus `DB`/`DW` sprite byte tables.
- **Hardware DIP Switch Panel (`app.js`)**: Toggle historical interpreter differences live on the front panel:
  - `SW1 (FX55/FX65 I-INC)`: 1977 COSMAC VIP advances `I` by `X + 1` after register load/store; 1990 HP-48 CHIP-48 leaves `I` unchanged.
  - `SW2 (8XY6/8XYE VY-SRC)`: COSMAC VIP copies `Vy` into `Vx` before shifting; CHIP-48 shifts `Vx` in place.
  - `SW3 (BNNN VX-JUMP)`: COSMAC VIP jumps to `NNN + V0`; CHIP-48 jumps to `XNN + Vx`.
  - `SW4 (CRT BLOOM)` & `SW5 (PIEZO 440 HZ)`: Optional phosphor halation and a 440 Hz square-wave tone generator that stays strictly muted on load (`AudioContext` is instantiated only after user interaction).
- **Instruction-Level Trace & RAM Inspector**: Every executed instruction is logged to a live 16-row trace table showing step count, instruction address (`PC`), 16-bit opcode word, disassembled mnemonic, index register (`I`), and carry/collision flag (`VF`), alongside a live 16-byte RAM hex window centered on the PC and highlighting `[PC, PC+1]`.
- **Quirk Lab + Time-Travel Debugger (`studio.js`)**: A 256-entry ring buffer captures the full machine snapshot before every executed instruction (registers, stack, PC, `I`, timers, keys, quirks, diagnostics, seeded RNG cursor, RAM and VRAM), so `STEP -1 OP` or the `B` key rewinds one instruction exactly - coverage counts and the trace tail roll back with it. Multi-address PC breakpoints (`0x200, 0x20A`) pause the run loop before execution, and continue slips past the hit address once.
- **Hardware Quirk-Profile Matrix**: Side-by-side `COSMAC VIP 1977`, `CHIP-48 1990` and `SCHIP-1.1 / MODERN` columns for all six quirks (`8XY1/2/3` VF reset, `FX55/65` I advance, `8XY6/E` shift source, `BNNN` jump offset, `DXYN` edge clipping, `FX0A` release semantics), plus a live column bound to the running CPU. Each row is backed by an executed micro-program probe on real CPU instances under each profile, so the divergence readout reports measured results, not lookup text.
- **Opcode-Family Coverage Heatmap**: A 16-cell inline SVG histogram counts executed instructions per opcode family (`0x0..0xF`) on the live timeline, reports the hottest family, and rewinds cell-by-cell when time travel undoes a step.
- **SHA-256 Checksummed Audit Exports**: `sha256.js` is a pure-JavaScript FIPS 180-4 implementation (verified against the standard known-answer vectors, including the million-`a` vector) used to stamp JSON, CSV and Markdown exports of the CPU state plus a deterministic seeded trace. The digest is honestly labeled as an *unkeyed* tamper-detection checksum - not a signature - and the CSV writer escapes spreadsheet formula leads (`=`, `+`, `-`, `@`, tab). `REPLAY + VERIFY` recomputes the digest, re-executes the cartridge deterministically comparing every traced step hash, and demonstrates tamper detection against a forged entry.
- **URL-Hash Bookmarking**: The live preset (hardware profile, three DIP overrides, clock rate, cartridge index) is encoded into `#c8=p=...;d=...;hz=...;r=...` on every change, so the location bar is always a shareable deep link restored at boot.
- **In-Page Self-Tests**: `RUN SELF-TESTS` executes 16 named checks in the live page - FIPS 180-4 vectors, all-35-opcode round-trip byte identity, the full 65,536-word disassemble/re-assemble sweep, verification-ROM golden cells, quirk-probe divergence, step-back exact restoration, ring capacity, CSV escaping, audit digest verification, tamper detection, and bookmark encode/decode.
- **Deterministic Trace & State Snapshots**: `Chip8.traceProgram(rom, steps, {seed, profile})` replays any cartridge on a fresh CPU with a seeded mulberry32 RNG and a recorded 60 Hz timer schedule (`timed` mode ticks once per `cyclesPerTick` executed instructions, 12 by default for a 720 Hz CPU, or `frozen` for an explicit CPU-only trace) and returns a per-instruction JSON report: fetch address, opcode word, quirk-aware disassembly (CHIP-48 offset jumps report `VX` and the resolved target), `I`/`SP`/`VF`/timer post-state, and a per-step hash of the full observable state (registers, timers, RNG cursor, RAM and VRAM) that diverges the moment two runs disagree, plus a canonical FNV-1a hash of the final machine. `cpu.snapshotState()` / `exportState()` serialize the register file, stack, timers, quirk flags, seeded RNG cursor, packed 4K RAM and bit-packed VRAM to JSON; `cpu.restoreState()` validates every field, the schema version, the hash algorithm and the mandatory embedded hash against a staged copy and commits to the live machine only after every check passes.
- **Safety Diagnostics & ROM Lint**: Runtime edge cases (SYS no-ops, sprite clipping and wrapping, `I`/RAM wraps past `0xFFF`, key-index masks, stack and opcode faults) are logged with code, severity, cycle and fetch address into a bounded feed under the trace table, while `Chip8.validateRom(bytes)` statically flags malformed bytes, odd lengths, low/unloaded jump targets and unassigned words before a cartridge runs.
- **Full Keyboard Bench**: Every transport and export control is reachable without a pointer: `SPACE` run/halt, `N` step (hold to repeat), `B` step-back (hold to repeat), `T` timer tick, `BKSP` reset, `[`/`]` cartridge cycle, `O` state export, `U` trace export, `M` piezo gate and `P` phosphor cycle. The `SW6` DIP switch disables every global character-key shortcut and physical hex-key input (WCAG 2.1.4) and persists in `localStorage`; Backspace, buttons and pointer controls stay live. Machine state transitions are announced in a deduplicated `aria-live` region.
- **Three Bench Display Modes**: Cycle between `P3 AMBER` (1977 warm amber phosphor), `P1 GREEN` (classic green oscilloscope phosphor), and `BENCH PAPER` (Heathkit technical manual daylight theme).

## Quick Start

Open `index.html` directly in any browser, or serve the directory locally:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## VP-580 Hex Keypad Mapping

The original RCA COSMAC VIP used a 16-key hexadecimal keypad (`0..F`). On a standard keyboard, the left-hand 4x4 block maps directly to the hex pad:

```
  Physical Keys      COSMAC VIP Hex Pad
  1  2  3  4    ->    1  2  3  C
  Q  W  E  R    ->    4  5  6  D
  A  S  D  F    ->    7  8  9  E
  Z  X  C  V    ->    A  0  B  F
```

| Cartridge | Bytes | Hex Keys | Mechanics |
| --------- | ----- | -------- | --------- |
| **Pong** | 186 B | `2` up, `8` down | Solo wall return. Uses `SUB` borrow flags in `VF` to test whether ball `Y` (`V1`) lands inside the 5-pixel paddle (`V4..V4+4`). Score is tracked in `V7`. |
| **Catch** | 102 B | `4` left, `6` right | Falling dot catcher. Uses `RND V0, 63` (`CXKK`) to spawn drops and 8-pixel bounding comparisons in `VF`. |
| **Navigator** | 106 B | `2` up, `4` left, `6` right, `8` down | Steer a 4x4 sprite onto a wandering target. Uses the hardware `DXYN` XOR collision latch (`VF = 1` when an active pixel is erased) to detect hits. |
| **Blaster** | 190 B | `4` left, `6` right, `5` fire | Vertical shooter with active projectile state (`V5 = 255` sentinel when idle) and 2D borrow-flag hit detection. |

## Running the Test Suite

```sh
node --test tests/
```

All 415 tests across `tests/` (engine, assembler, content, regression, edge case, trace/snapshot, diagnostics, opcode boundary, review regression, DOM workbench, studio logic and studio UI suites) run using Node's built-in test runner with zero external packages.

## Running the Headless Browser Audit

```sh
node scripts/audit-headless.mjs
```

Drives a real Chromium over the DevTools pipe protocol with zero npm dependencies: at `1440x900`, `390x844`, and a `#c8=` deep-link boot it verifies 0 console errors, 0 uncaught page errors, 0 external network requests, 0 horizontal overflow, and exercises the quirk switcher, step/step-back, the coverage SVG, the self-test runner, checksummed exports, tamper verification and bookmark application - 58 checks in total. Set `CHROME_PATH` to point at a different browser binary, or pass `--screens-dir <dir>` to capture viewports.

## License

MIT. See [LICENSE](LICENSE).
