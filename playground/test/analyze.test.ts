import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyze, MAX_INPUT_LENGTH } from "../src/analyze.ts";
import { isCatastrophic, PRESETS } from "../src/presets.ts";

describe("analyze", () => {
  it("accepts a test string of exactly the maximum length and rejects one longer", () => {
    expect(analyze("a", "a".repeat(MAX_INPUT_LENGTH), false).ok).toBe(true);
    expect(() => analyze("a", "a".repeat(MAX_INPUT_LENGTH + 1), false)).toThrow(RangeError);
  });

  it("reports a syntax error with the message and position of the library error", () => {
    expect(analyze("(a", "a", false)).toEqual({
      ok: false,
      message: "unterminated group at position 0",
      position: 0,
    });
    expect(analyze("a)", "a", false)).toEqual({
      ok: false,
      message: "unmatched ')' at position 1",
      position: 1,
    });
  });

  it("reports a rejected construct instead of approximating it", () => {
    expect(analyze("(?=a)", "a", false)).toEqual({
      ok: false,
      message: "lookaround is not supported at position 0",
      position: 0,
    });
  });

  it("lists one bytecode row per program counter, in order", () => {
    const result = analyze("a(b|c)*", "abcb", false);
    if (!result.ok) throw new Error("expected a match");
    expect(result.bytecode.length).toBeGreaterThan(3);
    result.bytecode.forEach((row, pc) => {
      expect(row.startsWith(String(pc).padStart(3, "0") + "  ")).toBe(true);
    });
  });

  it("reports the whole match and named captures, and agrees with the native engine", () => {
    const result = analyze("(?<year>\\d{4})-(\\d{2})", "on 2026-11 ok", false);
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
    expect(result.native).toEqual(result.library);
    expect(result.verdict).toBe("agree");
  });

  it("marks groups that did not participate as unset", () => {
    const result = analyze("(a)|b", "b", false);
    if (!result.ok) throw new Error("expected a match");
    expect(result.captures).toEqual([
      { label: "0 (whole match)", span: [0, 1], text: "b" },
      { label: "1", span: undefined, text: undefined },
    ]);
    expect(result.verdict).toBe("agree");
  });

  it("reports no match and no captures when the pattern does not occur", () => {
    const result = analyze("x+", "abc", false);
    expect(result).toEqual({
      ok: true,
      bytecode: expect.any(Array),
      captures: [],
      steps: expect.any(Array),
      graph: expect.any(Object),
      library: { kind: "none" },
      native: { kind: "none" },
      verdict: "agree",
    });
  });

  it("matches the empty pattern at offset zero", () => {
    const result = analyze("", "", false);
    if (!result.ok) throw new Error("expected a match");
    expect(result.library).toEqual({ kind: "match", match: { index: 0, end: 0, groups: [""] } });
    expect(result.verdict).toBe("agree");
  });

  it("traces every input position of the maximum-length input without truncation", () => {
    const result = analyze("(a|b)*c", "ab".repeat(MAX_INPUT_LENGTH / 2), false);
    if (!result.ok) throw new Error("expected a result");
    expect(result.steps.map((step) => step.pos)).toEqual(
      Array.from({ length: MAX_INPUT_LENGTH + 1 }, (_, pos) => pos),
    );
    expect(result.steps.some((step) => step.truncated === true)).toBe(false);
  });

  it("ends the trace with the match that the library reports", () => {
    const result = analyze("(?<year>\\d{4})-(\\d{2})", "on 2026-11 ok", false);
    if (!result.ok || result.library.kind !== "match") throw new Error("expected a match");
    const last = result.steps.at(-1);
    expect(last?.matched?.slice(0, 2)).toEqual([result.library.match.index, result.library.match.end]);
  });

  it("lays out the graph of the compiled program", () => {
    const result = analyze("a|b", "b", false);
    if (!result.ok) throw new Error("expected a result");
    expect(result.graph.nodes).toHaveLength(result.bytecode.length);
    expect(result.graph.edges).toHaveLength(3);
  });

  it("skips the native engine when asked, and says the comparison is unchecked", () => {
    const result = analyze("(a+)+b", "a".repeat(64), true);
    if (!result.ok) throw new Error("expected a result");
    expect(result.native).toEqual({ kind: "skipped" });
    expect(result.library).toEqual({ kind: "none" });
    expect(result.verdict).toBe("unchecked");
  });

  it("finishes the ReDoS pattern on the maximum-length input", () => {
    const result = analyze("(a+)+b", "a".repeat(MAX_INPUT_LENGTH), true);
    expect(result).toMatchObject({ ok: true, library: { kind: "none" } });
  });

  it("agrees with the native engine for every preset that it may run", () => {
    for (const preset of PRESETS) {
      const result = analyze(preset.pattern, preset.input, preset.catastrophic === true);
      expect(result.ok, preset.name).toBe(true);
      if (!result.ok) continue;
      expect(result.verdict, preset.name).toBe(preset.catastrophic === true ? "unchecked" : "agree");
      expect(preset.input.length, preset.name).toBeLessThanOrEqual(MAX_INPUT_LENGTH);
    }
  });

  it("agrees with the native engine on random inputs", () => {
    const alphabet = fc.constantFrom("a", "b", "c", " ");
    const inputs = fc.array(alphabet, { maxLength: MAX_INPUT_LENGTH }).map((chars) => chars.join(""));
    fc.assert(
      fc.property(inputs, (input) => {
        const result = analyze("(a|ab)(c|bcd)?d*|\\s+c", input, false);
        expect(result).toMatchObject({ ok: true, verdict: "agree" });
      }),
      { numRuns: 300 },
    );
  });
});

describe("isCatastrophic", () => {
  it("is true only for the exact text of a catastrophic preset", () => {
    expect(isCatastrophic("(a+)+b")).toBe(true);
    expect(isCatastrophic("(a+)+")).toBe(false);
    expect(isCatastrophic("(a+)+b ")).toBe(false);
    expect(isCatastrophic("cat|category")).toBe(false);
  });
});
