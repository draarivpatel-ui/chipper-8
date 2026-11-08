# Chipper-8

A dependency free CHIP-8 interpreter that runs entirely in your browser. It
ships with four original, playable games, a live CPU inspector, and a source
viewer that shows the assembly behind each cartridge. Everything is assembled
in the browser at load time, so the whole emulator works offline with no build
step, no server, and no network calls.

[Launch the emulator on GitHub Pages](https://draarivpatel-ui.github.io/chipper-8/)

## Highlights

- A complete CHIP-8 CPU: all 35 classic instructions, 4 KB of memory, a 64 by
  32 monochrome framebuffer, 16 registers, a 16 level stack, and 60 Hz delay
  and sound timers.
- Four built-in games written as readable assembly and compiled on the fly by
  the included mini assembler: **Pong**, **Catch**, **Navigator**, and
  **Blaster**.
- A live machine state panel with the program counter, index register, stack
  pointer, timers, the last disassembled opcode, and all sixteen V registers.
- Adjustable CPU speed from 60 to 2000 Hz, single stepping, pause, and reset.
- A clickable hex keypad plus physical keyboard controls.
- Optional pixel glow, a light and dark theme, and a Web Audio beep that stays
  **muted until you explicitly turn it on**.
- Zero dependencies. Plain HTML, CSS, and JavaScript.

## Quick start

Open `index.html` in any modern browser, or serve the folder with a static file
server:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

Pick a cartridge from the ROM library on the left and press **Play**.

## Controls

The CHIP-8 uses a 16 key hex pad. On a physical keyboard the mapping mirrors
the classic COSMAC VIP layout:

```
  1  2  3  4        1  2  3  C
  Q  W  E  R   ->   4  5  6  D
  A  S  D  F        7  8  9  E
  Z  X  C  V        A  0  B  F
```

You can also click or tap the on screen keypad. Each game lists the keys it
uses in the "How to play" panel and highlights them above the keypad.

| Game | Controls |
| ---- | -------- |
| Pong | `2` paddle up, `8` paddle down |
| Catch | `4` move left, `6` move right |
| Navigator | `2` up, `4` left, `6` right, `8` down |
| Blaster | `4` move left, `6` move right, `5` fire |

Global shortcuts: `Space` toggles play and pause.

## The four ROMs

- **Pong**: a solo wall. Return the ball with the left paddle; every successful
  return increments the score held in register `V7`. Missing serves a fresh
  ball.
- **Catch**: a dot falls from a random column. Slide the eight pixel paddle to
  catch it for a point.
- **Navigator**: steer a cursor onto a wandering goal. Sprite collision via XOR
  registers a hit and moves the goal to a new random spot.
- **Blaster**: line up the ship, fire, and hit the descending target to score.

The "ROM source" panel shows the exact assembly for the loaded game. Scores are
conventionally kept in `V7`, which is displayed in the score strip.

## Project layout

| File | Purpose |
| ---- | ------- |
| `engine.js` | The CHIP-8 CPU core. UMD style: exports `Chip8` in Node, `window.Chipper8.Chip8` in the browser. Also provides `disassemble` for the inspector. |
| `assembler.js` | A tiny two pass assembler. `assemble(source, origin)` turns the assembly text into a `Uint8Array`. Supports labels, `DB`/`DW`, and the standard mnemonics. |
| `roms.js` | The four built-in games as assembly source, compiled into ROM descriptors (`id`, `name`, `blurb`, `keys`, `bytes`) using the assembler. |
| `index.html` | The page structure. Loads the scripts in dependency order. |
| `style.css` | Dark first retro terminal styling with a light theme. |
| `app.js` | The browser front end: run loop, rendering, input, audio, inspector, and UI wiring. |
| `tests/engine.test.js` | 63 unit tests for the CPU, runnable with `node --test`. |

## Running the tests

```sh
node --test tests/
```

The engine is dependency free and runs in Node as well as the browser, so the
exact same code can be unit tested without a DOM.

## How it works

The browser loads `engine.js`, then `assembler.js`, then `roms.js`, then
`app.js`. `roms.js` calls `assemble()` on each game's source to produce a byte
array, which `app.js` hands to `cpu.load()`. On every animation frame the run
loop executes a budget of opcodes based on the chosen CPU speed and ticks the
timers at 60 Hz. When the CPU sets `drawFlag`, the framebuffer is painted onto a
canvas that is scaled up with nearest neighbour rendering for crisp pixels.

Sound is intentionally silent on load. The `AudioContext` and oscillator are
only created after you click the Sound toggle, and the gain node is gated on
both that toggle and a nonzero sound timer. Browsers block autoplaying audio,
and this design keeps the page completely quiet until you ask for it.

## Compatibility and quirks

The interpreter follows the original COSMAC VIP behaviour by default: `FX55`
and `FX65` advance the `I` register, shifts use `Vx`, and `BNNN` jumps relative
to `V0`. These are exposed as `cpu.quirks` flags in the engine for ROMs that
need the modern variants. The built-in games are written against the default
behaviour.

## License

MIT. See [LICENSE](LICENSE).
