# Security policy

Chipper-8 is a zero-dependency CHIP-8 virtual machine, assembler, and browser workbench that executes untrusted historical-style bytecode inside a constrained emulator.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest `main` | yes |

## Reporting a vulnerability

Report suspected security vulnerabilities privately through GitHub's security advisory form:

https://github.com/draarivpatel-ui/chipper-8/security/advisories/new

Do not open a public issue for a security problem. Include the affected file or component, the ROM or assembly input shape, steps to reproduce, the browser or Node.js version, and the commit tested.

We aim to acknowledge reports within 3 business days, complete an initial triage within 14 days, and release a fix or mitigation within 90 days when a report is confirmed. Please keep the report private while coordinated disclosure is underway.

## Scope

In scope are:

- Memory isolation failures in the CPU core, such as host-memory access outside the emulated bus
- Assembler parsing bugs that allow arbitrary host code execution in browser or Node.js contexts
- Cross-site scripting or injection through rendered workbench output
- Any path where untrusted ROM or assembly bytes influence the DOM outside the intended emulator display
- Unexpected network access or repository and workflow misconfiguration that could affect users

Out of scope are:

- A malformed ROM that only halts or glitches its own emulated machine
- Denial of service that affects only the local browser tab and does not cross the emulator boundary
- Reports of missing hardening features without an exploitable defect

## Safe harbour

We support good-faith security research. If you follow this policy, we will not pursue legal action against you, and we will credit your report if you would like.
