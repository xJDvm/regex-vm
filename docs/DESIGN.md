# regex-vm — design

## Problem
Backtracking regex engines (V8's Irregexp included) can take exponential time on patterns such as `(a+)+b`
against `aaaa…a` (ReDoS). `regex-vm` is a regular-expression engine for JavaScript strings with a **guaranteed
bound of (n+1)·m steps** (n = input length, m = program size; see invariant 2): pattern → AST → bytecode → **Pike VM** (Thompson
NFA simulation with captures). It reproduces JavaScript's leftmost, priority-ordered match semantics, and is
checked against V8 by differential fuzzing. A web playground animates the VM threads step by step.

What it shows a senior reviewer: automata theory applied (Thompson construction, Pike VM thread priority),
careful compatibility with an existing spec, adversarial testing (differential fuzzing, property tests,
complexity bounds asserted in tests), and a visual explanation of the algorithm.

## Scope for night 1 (MVP)
Syntax (non-Unicode JS semantics, UTF-16 code units):
- Literals, `.` (any code unit except `\n \r    `), escaped metacharacters `\. \* \\ …`.
- Escapes: `\d \D \w \W \s \S` (JS definitions, `\s` = JS WhiteSpace + LineTerminator), `\n \r \t \f \v \0`,
  `\xHH`, `\uHHHH`, `\cX`.
- Classes `[abc]`, `[a-z]`, `[^…]`, escapes inside classes, `\b` inside a class = backspace.
- Groups `(…)`, `(?:…)`, `(?<name>…)`; alternation `|`.
- Quantifiers `* + ? {n} {n,} {n,m}`, greedy and lazy (`*?` etc.).
- Assertions `^ $` (input start/end; no `m` flag yet), `\b \B` (ASCII word chars).
- **Rejected with a positioned `RegexSyntaxError`:** backreferences (`\1`, `\k<x>`), lookaround (`(?=`, `(?!`,
  `(?<=`, `(?<!`), flags other than `""`, Annex-B leniencies (lone `{`, `}`, `]` outside class, `\8`, invalid
  `\x`/`\u`), `{n,m}` with n > m, nothing to repeat, unterminated group/class, class range out of order.
  Rule: **if regex-vm accepts a pattern, `new RegExp(pattern)` accepts it too** (we are a strict subset).

Extensions for later nights: flags `i` / `m` / `s` / `g` / `y`, lazy DFA with state cache, Unicode (`u`/`v`),
literal prefix acceleration, one-pass/backtrack fast paths for small inputs.

## Limits (all enforced, all tested at N and N+1)
| Limit | Value | Error |
|---|---|---|
| Pattern length | 10 000 code units | `RegexSyntaxError` at 10 000 |
| Group nesting depth | 500 | at the `(` that exceeds it |
| Counted repetition bound | n, m ≤ 1 000 | at the `{` |
| Compiled program size | 50 000 instructions | `RegexSyntaxError("pattern too large")`, position 0 |
| Capture groups | 1 000 | at the `(` |
| Trace (playground only) | 2 000 steps | trace ends with `truncated: true` |

## Architecture (`src/`)
- `errors.ts` — `class RegexSyntaxError extends SyntaxError { readonly position: number }`; message
  `"<what> at position <p>"`.
- `ast.ts` — discriminated union:
  `Node = Empty | Char{code} | Any | Class{ranges: [lo,hi][] (sorted, merged), negated} | Seq{items} |
  Alt{alts} | Group{index | null, name | null, body} | Repeat{body, min, max (Infinity), greedy} |
  Assert{kind: "start" | "end" | "wordB" | "notWordB"}`. Every node carries `start`/`end` source offsets
  (used by the playground to highlight).
- `charclass.ts` — range helpers: `normalize`, `negate` over `[0, 0xFFFF]`, predefined `DIGIT`, `WORD`, `SPACE`,
  `contains(ranges, code)` with binary search.
- `parser.ts` — `parse(pattern: string): { ast: Node; groupCount: number; groupNames: Map<string, number> }`.
  Recursive descent with an explicit depth counter (≤ 500, so recursion depth is bounded). Duplicate group name
  → error.
- `print.ts` — `print(ast): string` canonical pattern text. Invariant: `parse(print(ast))` is structurally
  equal to `ast` (ignoring offsets). Used by the fuzzers' generators.
- `program.ts` — bytecode:
  ```
  Char c | Class idx | Any | Split x y (x has priority) | Jmp x | Save slot | ClearCaps lo hi |
  AssertStart | AssertEnd | WordB | NotWordB | Match
  ```
  `Program { insts: Inst[]; classes: Ranges[]; slotCount: number; groupNames: Map<string,number> }`.
  `disassemble(program): string` — one line per pc, e.g. `003  split 4, 7`.
- `compiler.ts` — `compileAst(parsed): Program`. Thompson construction; greedy `Split body, exit`, lazy
  `Split exit, body`. `{n,m}` expands to n copies + (m−n) optional copies (or a star when m = ∞), checked
  against the size limit **before** emitting (estimate = size(body)·copies). Each iteration of a quantified
  body that contains groups starts with `ClearCaps` for those groups (JS resets inner captures every iteration).
- `vm.ts` — `run(program, input, start, stats?): Int32Array | null` (slots, −1 = unset).
  Pike VM: two sparse-set thread lists of size m; `addThread` is **iterative** with an explicit stack (no
  recursion → no stack overflow on large programs); each pc is added at most once per input position, which is
  what bounds the work to O(m) per position. Captures copied on `Save`/`ClearCaps` only. Unanchored search
  seeds a new lowest-priority thread at each position until the first match is found; on `Match`, lower-priority
  threads in the current list are cut (leftmost + priority = backtracking order). Optional `stats.steps` counts
  thread additions.
- `regex.ts` — public API:
  ```ts
  compile(pattern: string, flags?: ""): Regex   // throws RegexSyntaxError
  class Regex {
    readonly source: string; readonly program: Program;
    exec(input: string, start?: number): Match | null;
    test(input: string, start?: number): boolean;
  }
  interface Match {
    index: number; end: number;
    groups: (string | undefined)[];             // [0] = whole match, like RegExp exec
    named: Record<string, string | undefined>;
    spans: ([number, number] | undefined)[];
  }
  ```
- `trace.ts` — `trace(program, input, maxSteps = 2000): Generator<Step>` with
  `Step { pos; threads: { pc; slots: number[] }[]; matched: number[] | null; truncated?: true }`. Same algorithm
  as `vm.ts` (shares `addThread`), but yields after each input position. Used only by the playground.
- `index.ts` — re-exports `compile`, `Regex`, `Match`, `RegexSyntaxError`, `parse`, `disassemble`, `trace`.

Zero runtime dependencies. Dev only: `typescript`, `eslint` + `typescript-eslint`, `vitest`, `fast-check`,
`vite` and `@playwright/test` (playground workspace).

## Invariants
1. Never throws anything but `RegexSyntaxError` from `compile`; `exec` never throws for any string input.
2. Work per input position ≤ program size: `stats.steps ≤ (n + 1) · insts.length`. The cost of each step is
   proportional to the slots it copies (`Save`/`ClearCaps` copy the thread's slots), so the worst case is
   O((n+1)·m·k), with k the number of slots and registers.
3. For accepted patterns, `index`, `end` and `groups[0]` equal V8's `RegExp.prototype.exec`.
4. Captures equal V8's, except for documented divergences on **empty iterations of nullable quantified bodies**
   (e.g. `(a*)*` vs `""`); the fuzzer skips capture comparison only when such a body exists, and the README lists
   it under Limitations.

## Testing
- Unit (vitest): parser cases + every error message/position, charclass ops, compiler output via
  `disassemble` snapshots for small patterns, VM cases (greedy vs lazy, alternation priority, anchors, `\b`,
  capture reset in loops, named groups, `start` offset).
- Property (fast-check):
  - parser: arbitrary strings → returns or throws `RegexSyntaxError`; never other errors; accepted ⇒ native
    `RegExp` accepts.
  - `parse(print(ast)) ≡ ast` for generated ASTs.
  - **differential**: generated ASTs in the supported subset (alphabet `a b c` + space + `\n`, depth ≤ 4) ×
    random inputs over the same alphabet → compare with `new RegExp(print(ast)).exec(input)` (invariants 3–4).
    ≥ 2 000 runs in CI, seedable via `FC_SEED`.
  - complexity: step bound (invariant 2) on generated patterns/inputs, and fixed ReDoS patterns
    `(a+)+b`, `(a|a)*b`, `(a*)*b`, `(\w+\s?)*$` on 10 000-char inputs finish under the bound.
- Benchmark `bench/redos.mjs` (built `dist/`): native vs regex-vm on `(a+)+b` × `"a".repeat(n)`; native only up
  to n = 24 (exponential), regex-vm up to n = 100 000. Prints a Markdown table; README uses only numbers from a
  real run, with machine/Node version stated.
- e2e (Playwright, playground): type pattern + input, step forward, assert active-thread count and highlighted
  bytecode rows, match result equals native, screenshot for README.

## Playground (`playground/`, npm workspace, Vite + vanilla TypeScript, no framework)
- Inputs: pattern, test string (≤ 200 chars), presets (email-ish, `(a+)+b` ReDoS, lazy vs greedy).
- Panels: bytecode listing (active pcs highlighted per step); NFA graph as SVG — instructions laid out left to
  right in pc order, `Jmp`/`Split` edges drawn as arcs (priority edge solid, other dashed), active threads as
  glowing nodes; input tape with the cursor; captures table; result vs native `RegExp` (native runs in a Worker with a
  300 ms timeout; the panel shows "timed out" or "rejected" when applicable).
- Controls: step, play/pause, speed, scrubber over the trace. Syntax errors show the caret at `position`.
- Dev server on `127.0.0.1:5173`. All DOM text set with `textContent` (no `innerHTML` with user input).

## Commit plan
0. docs: add design document
1. chore: scaffold TypeScript package with lint and tests
2. feat(parser): parse literals, classes, groups and alternation
3. feat(parser): add quantifiers, escapes, limits and positioned errors
4. test(parser): add printer and property tests for the parser
5. feat(compiler): compile the AST to Pike VM bytecode
6. feat(vm): run bytecode with a Pike VM and expose the compile/exec API
7. feat(vm): support assertions and reset captures on each loop iteration
8. test: differential fuzzing against V8 RegExp
9. test(vm): assert the linear step bound on ReDoS patterns
10. feat(trace): expose a step-by-step VM trace
11. perf: add ReDoS benchmark against native RegExp
12. feat(playground): add pattern editor, bytecode view and match results
13. feat(playground): animate VM threads over the NFA graph
14. test(e2e): drive the playground with Playwright
15. docs: add README with screenshots, benchmark and limitations
16. ci: add GitHub Actions workflow
17. chore: add CHANGELOG for v0.1.0

## Security notes
- The engine's purpose is DoS resistance: every limit above is tested; the VM has no recursion; trace output
  is capped.
- The fuzzers and benchmark never run native `RegExp` on catastrophic inputs beyond n = 24.
- Playground is static: no backend, no `eval`, no `innerHTML` with user data.
- CI: `permissions: contents: read`, official actions by major version, no secrets.
