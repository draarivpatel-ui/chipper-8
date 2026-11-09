# Contributing to Chipper-8

Thanks for your interest in Chipper-8. This project is a zero-dependency
CHIP-8 virtual machine, assembler, and hardware logic analyzer bench that runs
in the browser and in Node.js. Contributions of all sizes are welcome: bug
reports, ROMs, hardware-accuracy fixes, documentation, and accessibility work.

## Ground rules

- Be respectful and constructive. This project follows the Contributor
  Covenant, found in `CODE_OF_CONDUCT.md`.
- Keep the project dependency free. Do not add `node_modules`, build steps, or
  runtime libraries to the browser page or the engine. Node builtins and the
  `node:test` runner are fine.
- Keep the page offline. No network requests, no CDN assets, no analytics.

## Development setup

Requirements:

- Node.js 22 or newer (the test runner is `node --test`)
- A modern browser for manual verification
- Optional: `python3` to syntax check generated assembly artefacts

Clone the repository and run the suite:

```sh
git clone https://github.com/draarivpatel-ui/chipper-8.git
cd chipper-8
node --test
```

To exercise the workbench locally, serve the repository over HTTP so ES modules
and audio or worklet assets resolve under a standard origin:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## How the code is organised

| File | Role |
| --- | --- |
| `engine.js` | The CHIP-8 CPU, memory bus, display, timers, and quirk switches (UMD) |
| `assembler.js` | Two-pass assembler for CHIP-8 assembly (UMD) |
| `roms.js` | Source for the four bundled games, compiled at page load |
| `app.js` | UI wiring: benches, trace, RAM window, and hardware switches |
| `index.html`, `style.css` | The workbench shell and its styling |
| `tests/engine.test.js` | The test suite |

The engine is a UMD module, so `require('./engine.js')` works in Node.js and
`window.Chipper8` is available in the browser. Match that pattern in new
modules.

## Coding standards

- Use 2-space indentation and single quotes, matching the surrounding file.
- Prefer `const`, and use `let` only when reassignment is required.
- Keep functions small and single purpose. Name them after what they do.
- No comments that restate the code. Comment the reason, the hardware citation,
  or the non-obvious trade-off.
- Treat em-dashes and en-dashes as a defect in prose and identifiers. Use
  commas, parentheses, or a plain hyphen instead.
- Never swallow errors silently. Fail loudly with an actionable message.
- Keep pull requests focused. One concern per PR is easiest to review.

## Opening a pull request

1. Fork the repository and create a branch from `main`.
2. Make your change with tests. Every bug fix should include a regression test
  that fails before your fix.
3. Run the full suite locally: `node --test`.
4. Add or update documentation where behaviour changed.
5. Open the PR against `main` with:
   - a short summary of what changed and why,
   - the commands you ran and their result,
   - screenshots for UI changes,
   - an explicit statement of the hardware reference you followed, if the change
     affects CPU quirk behaviour.
6. Keep the PR small enough to review in one sitting, and respond to review
   promptly.

Commit messages: use a short imperative subject line under 72 characters. Put
the reasoning in the body, not the subject.

## Reporting bugs

Open an issue with the smallest reproduction you can manage: the ROM or
assembly snippet, the steps you ran, what you expected, and what happened
instead. Security issues follow `SECURITY.md` instead.

## Adding a ROM

New games are welcome. Drop the assembly source into `roms.js`, keep it
dependency free, and add a test that assembles it and steps it for a bounded
number of cycles without crashing. Games must not load external assets.
