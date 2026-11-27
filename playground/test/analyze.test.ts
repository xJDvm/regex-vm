import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyze, MAX_INPUT_LENGTH, type LibraryOutcome, type Verdict, verdictOf } from "../src/analyze.ts";
import { execNative } from "../src/native.ts";
import { PRESETS } from "../src/presets.ts";

/** The ReDoS preset: V8 needs about 2^64 steps on it, so only the worker's timeout may run it natively. */
const REDOS_PATTERN = "(a+)+b";

/** Compares regex-vm with the native engine on one input. Only for inputs on which V8 finishes quickly. */
function verdictFor(pattern: string, input: string): Verdict {
  const result = analyze(pattern, input);
  if (!result.ok) throw new Error("expected a compiled pattern");
  return verdictOf(result.library, execNative(pattern, input));
}

describe("analyze", () => {
  it("accepts a test string of exactly the maximum length and rejects one longer", () => {
    expect(analyze("a", "a".repeat(MAX_INPUT_LENGTH)).ok).toBe(true);
    expect(() => analyze("a", "a".repeat(MAX_INPUT_LENGTH + 1))).toThrow(RangeError);
  });

  it("reports a syntax error with the message and position of the library error", () => {
    expect(analyze("(a", "a")).toEqual({
      ok: false,
      message: "unterminated group at position 0",
      position: 0,
    });
    expect(analyze("a)", "a")).toEqual({
      ok: false,
      message: "unmatched ')' at position 1",
      position: 1,
    });
  });

  it("reports a rejected construct instead of approximating it", () => {
    expect(analyze("(?=a)", "a")).toEqual({
      ok: false,
      message: "lookaround is not supported at position 0",
      position: 0,
    });
  });

  it("lists one bytecode row per program counter, in order", () => {
    const result = analyze("a(b|c)*", "abcb");
    if (!result.ok) throw new Error("expected a match");
    expect(result.bytecode.length).toBeGreaterThan(3);
    result.bytecode.forEach((row, pc) => {
      expect(row.startsWith(String(pc).padStart(3, "0") + "  ")).toBe(true);
    });
  });

  it("reports the whole match and named captures, and agrees with the native engine", () => {
    const pattern = "(?<year>\\d{4})-(\\d{2})";
    const result = analyze(pattern, "on 2026-11 ok");
    if (!result.ok) throw new Error("expected a match");
    expect(result.library).toEqual({
      kind: "match",
      match: { index: 3, end: 10, groups: ["2026-11", "2026", "11"] },
    });
    expect(result.captures).toEqual([
      { label: "0 (whole match)", span: [3, 10], text: "2026-11" },
      { label: "1 (year)", span: [3, 7], text: "2026" },
      { label: "2", span: [8, 10], text: "11" },
    ]);
    expect(execNative(pattern, "on 2026-11 ok")).toEqual(result.library);
    expect(verdictFor(pattern, "on 2026-11 ok")).toBe("agree");
  });

  it("marks groups that did not participate as unset", () => {
    const result = analyze("(a)|b", "b");
    if (!result.ok) throw new Error("expected a match");
    expect(result.captures).toEqual([
      { label: "0 (whole match)", span: [0, 1], text: "b" },
      { label: "1", span: undefined, text: undefined },
    ]);
    expect(verdictFor("(a)|b", "b")).toBe("agree");
  });

  it("reports no match and no captures when the pattern does not occur", () => {
    const result = analyze("x+", "abc");
    expect(result).toEqual({
      ok: true,
      bytecode: expect.any(Array),
      captures: [],
      steps: expect.any(Array),
      graph: expect.any(Object),
      library: { kind: "none" },
    });
    expect(verdictFor("x+", "abc")).toBe("agree");
  });

  it("matches the empty pattern at offset zero", () => {
    const result = analyze("", "");
    if (!result.ok) throw new Error("expected a match");
    expect(result.library).toEqual({ kind: "match", match: { index: 0, end: 0, groups: [""] } });
    expect(verdictFor("", "")).toBe("agree");
  });

  it("traces every input position of the maximum-length input without truncation", () => {
    const result = analyze("(a|b)*c", "ab".repeat(MAX_INPUT_LENGTH / 2));
    if (!result.ok) throw new Error("expected a result");
    expect(result.steps.map((step) => step.pos)).toEqual(
      Array.from({ length: MAX_INPUT_LENGTH + 1 }, (_, pos) => pos),
    );
    expect(result.steps.some((step) => step.truncated === true)).toBe(false);
  });

  it("ends the trace with the match that the library reports", () => {
    const result = analyze("(?<year>\\d{4})-(\\d{2})", "on 2026-11 ok");
    if (!result.ok || result.library.kind !== "match") throw new Error("expected a match");
    const last = result.steps.at(-1);
    expect(last?.matched?.slice(0, 2)).toEqual([result.library.match.index, result.library.match.end]);
  });

  it("lays out the graph of the compiled program", () => {
    const result = analyze("a|b", "b");
    if (!result.ok) throw new Error("expected a result");
    expect(result.graph.nodes).toHaveLength(result.bytecode.length);
    expect(result.graph.edges).toHaveLength(3);
  });

  it("finishes the ReDoS pattern on the maximum-length input", () => {
    const result = analyze(REDOS_PATTERN, "a".repeat(MAX_INPUT_LENGTH));
    expect(result).toMatchObject({ ok: true, library: { kind: "none" } });
  });

  it("compiles every preset within the input limit, and agrees with the native engine on the fast ones", () => {
    for (const preset of PRESETS) {
      expect(preset.input.length, preset.name).toBeLessThanOrEqual(MAX_INPUT_LENGTH);
      const result = analyze(preset.pattern, preset.input);
      expect(result.ok, preset.name).toBe(true);
      if (preset.pattern !== REDOS_PATTERN) expect(verdictFor(preset.pattern, preset.input), preset.name).toBe("agree");
    }
  });

  it("agrees with the native engine on random inputs", () => {
    const alphabet = fc.constantFrom("a", "b", "c", " ");
    const inputs = fc.array(alphabet, { maxLength: MAX_INPUT_LENGTH }).map((chars) => chars.join(""));
    fc.assert(
      fc.property(inputs, (input) => {
        expect(verdictFor("(a|ab)(c|bcd)?d*|\\s+c", input)).toBe("agree");
      }),
      { numRuns: 300 },
    );
  });
});

describe("verdictOf", () => {
  const found: LibraryOutcome = { kind: "match", match: { index: 1, end: 3, groups: ["bc"] } };

  it("is unchecked when the native run timed out", () => {
    expect(verdictOf(found, { kind: "timeout" })).toBe("unchecked");
    expect(verdictOf({ kind: "none" }, { kind: "timeout" })).toBe("unchecked");
  });

  it("differs when V8 rejects a pattern that regex-vm accepted", () => {
    expect(verdictOf(found, { kind: "rejected", message: "Invalid regular expression" })).toBe("differ");
  });

  it("agrees on the same match, with the same span and capture texts", () => {
    expect(verdictOf(found, { kind: "match", match: { index: 1, end: 3, groups: ["bc"] } })).toBe("agree");
    expect(verdictOf({ kind: "none" }, { kind: "none" })).toBe("agree");
  });

  it("differs on a different span, a different capture text, or a match against no match", () => {
    expect(verdictOf(found, { kind: "match", match: { index: 0, end: 2, groups: ["ab"] } })).toBe("differ");
    expect(verdictOf(found, { kind: "match", match: { index: 1, end: 3, groups: ["bc", "b"] } })).toBe("differ");
    expect(verdictOf(found, { kind: "none" })).toBe("differ");
    expect(verdictOf({ kind: "none" }, { kind: "match", match: { index: 0, end: 0, groups: [""] } })).toBe("differ");
  });
});
