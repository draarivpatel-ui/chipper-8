# Chipper-8

## Inspiration

Most browser emulators hide what the CPU is actually doing behind a black-box canvas. We wanted a front-panel CHIP-8 workbench where someone learning computer architecture can type assembly, click one-button experiments, inspect every register and pixel in memory, and toggle historical interpreter quirks from 1977 COSMAC VIP hardware alongside 1990 HP-48 CHIP-48 behavior.

## What it does

Chipper-8 runs a complete 35-instruction CHIP-8 virtual machine, a two-pass symbolic assembler, and an interactive logic-bench UI with zero external dependencies:

- **Four playable original cartridges** assembled from source on boot (`Pong` 186 B, `Catch` 102 B, `Navigator` 106 B, `Blaster` 190 B).
- **Live Assembly Editor & ROM Exporter**: Write or edit CHIP-8 assembly in the browser, load valid ROMs without wiping state on empty/invalid edits, and download raw `.ch8` binaries.
- **Historical Quirk Profiles & DIP Switches**: Switch between `Modern`, `VIP` (1977 COSMAC VIP), and `CHIP-48` presets or toggle `I`-increment, shift source (`Vy` vs `Vx`), and offset jump (`V0` vs `Vx`) quirks live.
- **Instruction-Level Trace, 16-Byte RAM Window & Pixel Inspector**: Watch `PC`, `I`, `SP`, `DT`, `ST`, decoded IR, `V0..VF` changes, a 16-row trace, the active PC-centered `[PC, PC+1]` RAM window, and live `[x, y]` framebuffer values and VRAM offsets.
- **Deterministic Trace & State JSON Export**: One click replays the active cartridge on a fresh CPU with a seeded RNG, the live DIP quirks and a recorded 60 Hz timer schedule matching the bench clock, producing a byte-identical per-instruction JSON trace (fetch address, opcode, quirk-aware disassembly with resolved jump targets, post-state fields and a per-step full-state hash over registers, timers, RNG cursor, RAM and VRAM) sealed with a canonical FNV-1a state hash. A second export serializes registers, stack, timers, quirks, the RNG cursor, packed RAM and VRAM, and `restoreState()` validates every field, the schema version, the hash algorithm and the mandatory embedded hash against a staged copy before committing.
- **Safety Diagnostics & ROM Lint**: Runtime edge cases (SYS no-ops, sprite clip/wrap, `I`/RAM wraps past `0xFFF`, key-index masks, stack and opcode faults) stream into a bounded coded diagnostic feed, and a static ROM linter flags malformed bytes, odd lengths, low/unloaded jump targets and unassigned words before code runs.
- **Full Keyboard Bench & Live Announcements**: Every control works without a pointer (`SPACE` halt, `N` step, `T` tick, `BKSP` reset, `[`/`]` cartridges, `O`/`U` exports, `M` piezo, `P` phosphor), the `SW6` DIP switch persistently disables all single-key shortcuts per WCAG 2.1.4, and state transitions are announced through a deduplicated `aria-live` region.
- **One-Click Diagnostic Showcases**: Demonstrate `DXYN` XOR draw-vs-erase collision (`VF = 0` on draw, `VF = 1` on erase) and live divergence of opcode `8126` across three independent CPU instances (`MODERN`, `VIP`, `CHIP48`).

## How we built it

- **Engine (`engine.js`)**: Pure JavaScript VM with 4,096 bytes of RAM, built-in 4x5 hexadecimal font sprites at `0x000..0x04F`, 64x32 XOR display buffer, 16-level call stack, 60 Hz delay/sound timers, full 35-opcode execution, and lossless 16-bit disassembly (`DW 0xNNNN` fallback for non-instruction words).
- **Two-Pass Assembler (`assembler.js`)**: Pass 1 strips `;`/`//` comments and builds a case-normalized symbol table from `0x200`; Pass 2 validates register operands, arity, and bounds before emitting big-endian machine code and `DB`/`DW` byte tables.
- **Independent Clock & Bench UI (`clock.js`, `app.js`)**: Separates opcode stepping (`60..2000 Hz`) from 60 Hz timer ticks at any frame rate, tracks physical, pointer, and virtual keyboard input sources independently, and verifies all 35 opcode families on startup via disassemble-assemble round trips.

## Challenges

- **Historical Quirk Fidelity**: Capturing pre-write `VF` collisions in `8XYN` arithmetic and `DXYN` sprites when `Vx` or `Vy` is `VF` itself across all 256 register-pair combinations.
- **Safe Input & State Transitions**: Ensuring virtual keypad releases or blurs never cancel held physical keys, rejecting empty/comment-only assembly before resetting CPU registers or active cartridges, and updating pixel VRAM readouts immediately whenever `CLS` or sprite draws alter the display.
- **Assembler Determinism**: Handling case-insensitive single-letter labels (`i`, `b`, `f`) alongside register/special operands (`I`, `DT`, `ST`, `K`, `[I]`) without mangling label names.

## Verification

- **278 tests passed, 0 failed, 0 skipped** across engine, assembler, content, regression, edge case, trace/snapshot, diagnostics, opcode boundary, review regression and DOM workbench suites, verified on Node v26.8.1 with `node --test tests/` and zero external packages.
- **Determinism proven by test**: identical ROM + seed + quirks produce byte-identical trace JSON and equal canonical state hashes; snapshot -> restore -> snapshot round trips preserve the exact FNV-1a hash.
- Exhaustive **65,536-word** (`0x0000..0xFFFF`) disassemble -> assemble round-trip verification passes with zero mismatches.
- Startup self-test verifies **35 instruction round trips** directly inside the booted workbench.
- Actual cartridge bytecode sizes verified from `roms.js`: **Pong 186 B**, **Catch 102 B**, **Navigator 106 B**, **Blaster 190 B**.

## What's next

Add Super-CHIP (S-CHIP) 128x64 high-resolution display mode, configurable memory breakpoints on read/write (`FX55`/`FX65`), and step-backwards execution snapshots for classroom debugging.
