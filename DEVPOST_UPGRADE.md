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
- **256-Step Time-Travel Debugger**: A ring buffer snapshots the complete machine (PC, `I`, `V0..VF`, stack, timers, keys, quirks, diagnostics, seeded RNG cursor, 4K RAM and the full framebuffer) before every executed instruction, so `STEP -1 OP` or `B` restores the exact prior state - and rewinds the coverage histogram and trace tail with it.
- **Quirk-Profile Matrix with Live Divergence Probes**: A side-by-side `VIP 1977` / `CHIP-48 1990` / `SCHIP-1.1` table for all six historical quirks plus a live column, where every row is backed by an identical micro-program executed on real CPU instances per profile - measured divergence, not lookup text.
- **Opcode-Family Coverage Heatmap**: A 16-cell inline SVG counts executed instructions per opcode family on the live timeline and un-counts them on rewind.
- **Multi-Address PC Breakpoints**: Comma/space-separated hex lists (`0x200, 0x20A`) pause before execution at any configured PC and continue past a hit once.
- **SHA-256 Checksummed Audit Exports**: Pure-JS FIPS 180-4 SHA-256 stamps JSON / CSV / Markdown exports of CPU state plus a deterministic seeded trace - honestly labeled as an *unkeyed* tamper-detection digest, with spreadsheet formula-injection escaping and a `REPLAY + VERIFY` button that recomputes the digest, re-executes the ROM step-by-step, and proves a forged entry is caught.
- **URL-Hash Preset Bookmarks**: `#c8=p=...;d=...;hz=...;r=...` encodes profile, DIP overrides, clock and cartridge so the address bar is always a shareable deep link.
- **In-Page Self-Tests**: `RUN SELF-TESTS` runs 16 named checks live in the page - SHA-256 known-answer vectors, 35-opcode and full 65,536-word round trips, verification-ROM golden cells, quirk divergence, exact step-back restoration, CSV escaping, tamper detection and bookmark round trips.

## How we built it

- **Engine (`engine.js`)**: Pure JavaScript VM with 4,096 bytes of RAM, built-in 4x5 hexadecimal font sprites at `0x000..0x04F`, 64x32 XOR display buffer, 16-level call stack, 60 Hz delay/sound timers, full 35-opcode execution, and lossless 16-bit disassembly (`DW 0xNNNN` fallback for non-instruction words).
- **Two-Pass Assembler (`assembler.js`)**: Pass 1 strips `;`/`//` comments and builds a case-normalized symbol table from `0x200`; Pass 2 validates register operands, arity, and bounds before emitting big-endian machine code and `DB`/`DW` byte tables.
- **Independent Clock & Bench UI (`clock.js`, `app.js`)**: Separates opcode stepping (`60..2000 Hz`) from 60 Hz timer ticks at any frame rate, tracks physical, pointer, and virtual keyboard input sources independently, and verifies all 35 opcode families on startup via disassemble-assemble round trips.
- **Studio module (`studio.js`, `sha256.js`)**: The time machine and coverage tracker reuse the same snapshot/restore machinery the deterministic trace already validates, so undo is exact by construction. A hand-rolled FIPS 180-4 SHA-256 (no WebCrypto - the page must work fully offline and identically in Node) feeds a canonical-JSON digest over the audit payload, the CSV layer prefixes formula-leading cells, and the bookmark codec packs the preset into a compact `#c8=` hash.

## Challenges

- **Historical Quirk Fidelity**: Capturing pre-write `VF` collisions in `8XYN` arithmetic and `DXYN` sprites when `Vx` or `Vy` is `VF` itself across all 256 register-pair combinations.
- **Safe Input & State Transitions**: Ensuring virtual keypad releases or blurs never cancel held physical keys, rejecting empty/comment-only assembly before resetting CPU registers or active cartridges, and updating pixel VRAM readouts immediately whenever `CLS` or sprite draws alter the display.
- **Assembler Determinism**: Handling case-insensitive single-letter labels (`i`, `b`, `f`) alongside register/special operands (`I`, `DT`, `ST`, `K`, `[I]`) without mangling label names.

## Verification

- **400 tests passed, 0 failed, 0 skipped** across engine, assembler, content, regression, edge case, trace/snapshot, diagnostics, opcode boundary, review regression, DOM workbench, studio logic and studio UI suites, verified on Node v26.8.1 with `node --test tests/` and zero external packages.
- **58/58 real-browser checks passed** in headless Chromium (`scripts/audit-headless.mjs`, zero-dep raw CDP over `--remote-debugging-pipe`) at `1440x900`, `390x844` and a `#c8=` deep-link boot: 0 console errors, 0 uncaught page errors, 0 external network requests, 0 horizontal overflow, plus exercised quirk switching, step/step-back, the coverage SVG, the self-test runner, checksummed exports, tamper verification and bookmark application.
- **16/16 in-page self-tests passed** - FIPS 180-4 SHA-256 known-answer vectors (including the million-`a` vector), 35-opcode and exhaustive 65,536-word round-trip byte identity, 38 verification-ROM golden check cells, quirk-probe divergence, exact step-back state restoration, ring-capacity eviction, CSV formula escaping, audit digest verification, forged-entry tamper detection and bookmark encode/decode.
- **Determinism proven by test**: identical ROM + seed + quirks produce byte-identical trace JSON and equal canonical state hashes; snapshot -> restore -> snapshot round trips preserve the exact FNV-1a hash.
- Startup self-test verifies **35 instruction round trips** directly inside the booted workbench.
- Actual cartridge bytecode sizes verified from `roms.js`: **Pong 186 B**, **Catch 102 B**, **Navigator 106 B**, **Blaster 190 B**.

## What's next

Add Super-CHIP (S-CHIP) 128x64 high-resolution display mode and configurable memory watchpoints on read/write (`FX55`/`FX65`).
