# Chipper-8

A zero-dependency CHIP-8 virtual machine, two-pass assembler, and 1977 RCA COSMAC VIP hardware workbench that runs in the browser and in Node.js. It includes four original games written in CHIP-8 assembly, compiled into bytecode at page load, paired with an instruction-level trace, a 16-byte RAM window around the program counter, and hardware DIP switches for historical interpreter quirks.

[Launch the workbench on GitHub Pages](https://draarivpatel-ui.github.io/chipper-8/)

## Architecture & Hardware Specifications

- **Complete 1977 COSMAC VIP VM (`engine.js`)**: All 35 classic instructions, 4096 bytes of flat RAM (`0x000..0xFFF` with built-in hex font sprites at `0x000..0x04F` and cartridge ROM space starting at `0x200`), a 64x32 monochrome XOR framebuffer (`DXYN` with collision latch in `VF`), sixteen 8-bit general registers (`V0..VF`), a 16-level subroutine stack, a 12-bit index register (`I`), and 60 Hz delay and sound timers.
- **Two-Pass Symbolic Assembler (`assembler.js`)**: Pass 1 strips `;` and `//` comments, tracks byte offsets from `0x200`, and builds the symbol table for forward and backward labels. Pass 2 resolves label addresses and emits big-endian 16-bit opcodes plus `DB`/`DW` sprite byte tables.
- **Hardware DIP Switch Panel (`app.js`)**: Toggle historical interpreter differences live on the front panel:
  - `SW1 (FX55/FX65 I-INC)`: 1977 COSMAC VIP advances `I` by `X + 1` after register load/store; 1990 HP-48 CHIP-48 leaves `I` unchanged.
  - `SW2 (8XY6/8XYE VY-SRC)`: COSMAC VIP copies `Vy` into `Vx` before shifting; CHIP-48 shifts `Vx` in place.
  - `SW3 (BNNN VX-JUMP)`: COSMAC VIP jumps to `NNN + V0`; CHIP-48 jumps to `XNN + Vx`.
  - `SW4 (CRT BLOOM)` & `SW5 (PIEZO 440 HZ)`: Optional phosphor halation and a 440 Hz square-wave tone generator that stays strictly muted on load (`AudioContext` is instantiated only after user interaction).
- **Instruction-Level Trace & RAM Inspector**: Every executed instruction is logged to a live 16-row trace table showing step count, instruction address (`PC`), 16-bit opcode word, disassembled mnemonic, index register (`I`), and carry/collision flag (`VF`), alongside a live 16-byte RAM hex window centered on the PC and highlighting `[PC, PC+1]`.
- **Deterministic Trace & State Snapshots**: `Chip8.traceProgram(rom, steps, {seed, profile})` replays any cartridge on a fresh CPU with a seeded mulberry32 RNG and a recorded 60 Hz timer schedule (`timed` mode ticks once per `cyclesPerTick` executed instructions, 12 by default for a 720 Hz CPU, or `frozen` for an explicit CPU-only trace) and returns a per-instruction JSON report: fetch address, opcode word, quirk-aware disassembly (CHIP-48 offset jumps report `VX` and the resolved target), `I`/`SP`/`VF`/timer post-state, and a per-step hash of the full observable state (registers, timers, RNG cursor, RAM and VRAM) that diverges the moment two runs disagree, plus a canonical FNV-1a hash of the final machine. `cpu.snapshotState()` / `exportState()` serialize the register file, stack, timers, quirk flags, seeded RNG cursor, packed 4K RAM and bit-packed VRAM to JSON; `cpu.restoreState()` validates every field, the schema version, the hash algorithm and the mandatory embedded hash against a staged copy and commits to the live machine only after every check passes.
- **Safety Diagnostics & ROM Lint**: Runtime edge cases (SYS no-ops, sprite clipping and wrapping, `I`/RAM wraps past `0xFFF`, key-index masks, stack and opcode faults) are logged with code, severity, cycle and fetch address into a bounded feed under the trace table, while `Chip8.validateRom(bytes)` statically flags malformed bytes, odd lengths, low/unloaded jump targets and unassigned words before a cartridge runs.
- **Full Keyboard Bench**: Every transport and export control is reachable without a pointer: `SPACE` run/halt, `N` step (hold to repeat), `T` timer tick, `BKSP` reset, `[`/`]` cartridge cycle, `O` state export, `U` trace export, `M` piezo gate and `P` phosphor cycle. The `SW6` DIP switch disables every global character-key shortcut and physical hex-key input (WCAG 2.1.4) and persists in `localStorage`; Backspace, buttons and pointer controls stay live. Machine state transitions are announced in a deduplicated `aria-live` region.
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

All 278 tests across `tests/` (engine, assembler, content, regression, edge case, trace/snapshot, diagnostics, opcode boundary, review regression and DOM workbench suites) run using Node's built-in test runner with zero external packages.

## License

MIT. See [LICENSE](LICENSE).
