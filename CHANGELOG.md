# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-27

### Added

- Parser for JavaScript regex syntax (non-Unicode, UTF-16 code units) with explicit limits on pattern length,
  group nesting depth, counted-repetition bounds, program size and capture count, and positioned
  `RegexSyntaxError` diagnostics.
- Compiler from the AST to Pike VM bytecode (Thompson construction), with per-iteration capture reset inside
  quantified groups.
- Pike VM with linear-time matching: work per input position is bounded by the program size.
- Public API: `compile`, `Regex#exec`, `Regex#test`, and `trace` for step-by-step VM inspection.
- Differential fuzzing against V8's `RegExp` using fast-check.
- Step-bound tests asserting the linear complexity bound, including fixed ReDoS patterns on 10 000-character inputs.
- ReDoS benchmark comparing native `RegExp` with regex-vm.
- Playground with a pattern editor, bytecode view, and an animated NFA graph of VM threads.
- End-to-end tests for the playground with Playwright.

### Known limitations

- Capture spans can diverge from V8 on empty iterations of nullable quantified bodies (for example `(a*)*` against `""`).
- No flags: `i`, `m`, `s`, `g`, `y`, `u` and `v` are rejected.
- Unicode is not supported by code point; matching operates on UTF-16 code units.
