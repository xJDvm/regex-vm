import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RegexSyntaxError } from "../src/errors.js";
import { compile, type Match, type Regex } from "../src/regex.js";
import { propertyOptions } from "./arbitraries.js";

/** Runs `action`, which must throw, and returns the error it threw. */
function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw");
}

/** Returns the match of `pattern` in `input`, failing the test when there is none. */
function matchOf(pattern: string, input: string, start?: number): Match {
  const match = compile(pattern).exec(input, start);
  if (match === null) throw new Error(`expected ${pattern} to match ${JSON.stringify(input)}`);
  return match;
}

describe("compile", () => {
  it("keeps the source and the program of the pattern", () => {
    const regex = compile("a(b)");
    expect(regex.source).toBe("a(b)");
    expect(regex.program.slotCount).toBe(4);
    expect(regex.program.insts[0]).toEqual({ op: "save", slot: 0 });
  });

  it("accepts the empty flags string", () => {
    expect(compile("a", "").test("a")).toBe(true);
  });

  it("rejects any other flags with a RegexSyntaxError at position 0", () => {
    const error = errorOf(() => compile("a", "i" as string as ""));
    expect(error).toBeInstanceOf(RegexSyntaxError);
    expect(error).toMatchObject({ position: 0, message: "unsupported flags at position 0" });
  });

  it("rejects an unsupported pattern with a RegexSyntaxError", () => {
    expect(() => compile("(a")).toThrow(RegexSyntaxError);
    expect(() => compile("\\1")).toThrow(RegexSyntaxError);
    expect(() => compile("(?=a)")).toThrow(RegexSyntaxError);
  });
});

describe("Regex.exec", () => {
  it("returns null when there is no match", () => {
    expect(compile("x").exec("abc")).toBeNull();
    expect(compile("a+").exec("")).toBeNull();
  });

  it("describes the whole match and each group", () => {
    expect(matchOf("(a)(b)?", "xab")).toEqual({
      index: 1,
      end: 3,
      groups: ["ab", "a", "b"],
      named: {},
      spans: [
        [1, 3],
        [1, 2],
        [2, 3],
      ],
    });
  });

  it("reports a group that did not participate as undefined", () => {
    const match = matchOf("(a)|(b)", "b");
    expect(match.groups).toEqual(["b", undefined, "b"]);
    expect(match.spans).toEqual([[0, 1], undefined, [0, 1]]);
  });

  it("maps named groups to their text, keeping unmatched names as undefined", () => {
    const match = matchOf("(?<year>\\d{4})-(?<month>\\d\\d)?|(?<none>z)", "2026-");
    expect(match.named).toEqual({ year: "2026", month: undefined, none: undefined });
    expect(Object.keys(match.named)).toEqual(["year", "month", "none"]);
  });

  it("treats a group named __proto__ as an ordinary key", () => {
    const match = matchOf("(?<__proto__>a)", "a");
    expect(Object.getPrototypeOf(match.named)).toBeNull();
    expect(Object.keys(match.named)).toEqual(["__proto__"]);
    expect(match.named["__proto__"]).toBe("a");
  });

  it("returns the leftmost, then highest-priority match", () => {
    expect(matchOf("a|ab", "xabc")).toMatchObject({ index: 1, end: 2, groups: ["a"] });
    expect(matchOf("a+?", "aaa")).toMatchObject({ index: 0, end: 1 });
  });

  it("searches from the start offset", () => {
    expect(matchOf("a", "aXa", 1)).toMatchObject({ index: 2, end: 3 });
    expect(compile("a").exec("aXa", 3)).toBeNull();
  });

  it("truncates a fractional start offset", () => {
    expect(matchOf("a", "aXa", 1.9)).toMatchObject({ index: 2 });
  });

  it("treats a negative or NaN start offset as zero", () => {
    expect(matchOf("a", "aXa", -4)).toMatchObject({ index: 0 });
    expect(matchOf("a", "aXa", Number.NaN)).toMatchObject({ index: 0 });
  });

  it("finds nothing when the start offset is past the end of the input", () => {
    expect(compile("").exec("ab", 3)).toBeNull();
    expect(compile("").exec("ab", Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("finds an empty match at the end of the input", () => {
    expect(matchOf("$", "ab", 2)).toMatchObject({ index: 2, end: 2 });
  });

  it("runs in linear time on a catastrophic pattern", () => {
    const input = "a".repeat(10_000);
    expect(compile("(a+)+b").exec(input)).toBeNull();
  });
});

describe("Regex.test", () => {
  it("reports whether a match exists, honouring the start offset", () => {
    const regex = compile("ab");
    expect(regex.test("xab")).toBe(true);
    expect(regex.test("xab", 2)).toBe(false);
    expect(regex.test("")).toBe(false);
  });
});

/** Strings of up to `maxLength` arbitrary UTF-16 code units, lone surrogates included. */
function codeUnits(maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength }).map((units) => String.fromCharCode(...units));
}

/** Patterns from the supported subset whose results must equal V8's, captures included. */
const NATIVE_PATTERNS = [
  "a+",
  "a+?",
  "a*b",
  "(a|ab)(c|bcd)(d*)",
  "(a*)b",
  "x?(a|b)*?y",
  "(\\d+)-(\\d*)",
  "^a$",
  "\\bab\\b",
  "\\Bb",
  "(?<w>a+)(b)?",
  "a{2,3}",
  "a{2,}?b",
  "[^ab]+c",
  ".",
  "(?:(a)|b)+",
  "(a)|b",
  "(a|b)*c",
  "a|",
  "(a+?)(a*)",
  "\\w+\\s?",
  "[a-c ]{1,2}\\n?",
  "(?<x>a)(?:(b)|c)*",
  "((a)|b){2}",
];

/** Characters of the differential inputs; they cover every atom of {@link NATIVE_PATTERNS}. */
const INPUT_CHARS = ["a", "b", "c", "d", "y", "1", "-", " ", "\n", "_"];

describe("Regex.exec agrees with RegExp.prototype.exec", () => {
  it("returns the same indices, groups and named groups", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NATIVE_PATTERNS),
        fc.string({ unit: fc.constantFrom(...INPUT_CHARS), maxLength: 12 }),
        fc.nat(12),
        (pattern, input, offset) => {
          const start = Math.min(offset, input.length);
          const native = new RegExp(pattern, "g");
          native.lastIndex = start;
          const expected = native.exec(input);
          const actual = compile(pattern).exec(input, start);
          if (expected === null) {
            expect(actual).toBeNull();
            return;
          }
          expect(actual).not.toBeNull();
          if (actual === null) return;
          expect(actual.index).toBe(expected.index);
          expect(actual.end).toBe(expected.index + expected[0].length);
          expect(actual.groups).toEqual([...expected]);
          expect({ ...actual.named }).toEqual({ ...expected.groups });
        },
      ),
      propertyOptions(),
    );
  });
});

describe("Regex.exec never throws", () => {
  it("returns a well-formed result or null for any pattern accepted by compile", () => {
    const patternChars = ["a", "b", "(", ")", "|", "*", "+", "?", "[", "]", "{", "}", "^", "$", "\\", "."];
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...patternChars, "1", "2", ",", "-", "w", "b", "B", "s", "n"), maxLength: 16 }),
        codeUnits(16),
        fc.integer({ min: -2, max: 20 }),
        (pattern, input, start) => {
          let regex: Regex;
          try {
            regex = compile(pattern);
          } catch (error) {
            expect(error).toBeInstanceOf(RegexSyntaxError);
            return;
          }
          expect(() => new RegExp(pattern)).not.toThrow();
          const match = regex.exec(input, start);
          if (match === null) return;
          expect(match.index).toBeGreaterThanOrEqual(0);
          expect(match.index).toBeLessThanOrEqual(match.end);
          expect(match.end).toBeLessThanOrEqual(input.length);
          expect(match.groups[0]).toBe(input.slice(match.index, match.end));
        },
      ),
      propertyOptions(),
    );
  });

  it("does not throw for any input string, including lone surrogates", () => {
    const regex = compile("(\\w+)\\s|.\\b");
    fc.assert(
      fc.property(codeUnits(64), (input) => {
        expect(() => regex.exec(input)).not.toThrow();
        expect(() => regex.test(input)).not.toThrow();
      }),
      propertyOptions(),
    );
  });
});
