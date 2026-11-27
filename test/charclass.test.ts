import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CodeRange, contains, DIGIT, negate, normalize, type Ranges, SPACE, WORD } from "../src/charclass.js";

const MAX = 0xffff;

/** Generates a list of valid (lo <= hi) ranges within the code-unit universe. */
const rangesArb: fc.Arbitrary<Ranges> = fc.array(
  fc.tuple(fc.integer({ min: 0, max: MAX }), fc.integer({ min: 0, max: 300 })).map(([lo, width]): CodeRange => {
    return [lo, Math.min(MAX, lo + width)];
  }),
  { maxLength: 12 },
);

/** Brute-force membership test used as the reference for {@link contains}. */
function containsNaive(ranges: Ranges, code: number): boolean {
  return ranges.some(([lo, hi]) => lo <= code && code <= hi);
}

describe("normalize", () => {
  it("returns an empty list for no ranges", () => {
    expect(normalize([])).toEqual([]);
  });

  it("sorts ranges", () => {
    expect(normalize([[10, 12], [1, 2]])).toEqual([[1, 2], [10, 12]]);
  });

  it("merges overlapping ranges", () => {
    expect(normalize([[1, 5], [3, 9]])).toEqual([[1, 9]]);
  });

  it("merges adjacent ranges", () => {
    expect(normalize([[97, 99], [100, 102]])).toEqual([[97, 102]]);
  });

  it("keeps ranges separated by a gap of one code unit", () => {
    expect(normalize([[97, 97], [99, 99]])).toEqual([[97, 97], [99, 99]]);
  });

  it("absorbs a range contained in another", () => {
    expect(normalize([[0, 100], [10, 20]])).toEqual([[0, 100]]);
  });

  it("handles the extreme code units", () => {
    expect(normalize([[MAX, MAX], [0, 0]])).toEqual([[0, 0], [MAX, MAX]]);
  });

  it("does not modify its input", () => {
    const input: CodeRange[] = [[5, 6], [1, 2]];
    normalize(input);
    expect(input).toEqual([[5, 6], [1, 2]]);
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(rangesArb, (ranges) => {
        const once = normalize(ranges);
        expect(normalize(once)).toEqual(once);
      }),
    );
  });

  it("produces sorted, disjoint, non-adjacent ranges", () => {
    fc.assert(
      fc.property(rangesArb, (ranges) => {
        const out = normalize(ranges);
        for (const [lo, hi] of out) expect(lo).toBeLessThanOrEqual(hi);
        for (let i = 1; i < out.length; i++) {
          const prev = out[i - 1];
          const cur = out[i];
          if (prev === undefined || cur === undefined) throw new Error("unreachable index");
          expect(cur[0]).toBeGreaterThan(prev[1] + 1);
        }
      }),
    );
  });
});

describe("negate", () => {
  it("negates the empty list to the full universe", () => {
    expect(negate([])).toEqual([[0, MAX]]);
  });

  it("negates the full universe to the empty list", () => {
    expect(negate([[0, MAX]])).toEqual([]);
  });

  it("produces the gaps on both sides of a range", () => {
    expect(negate([[10, 20]])).toEqual([[0, 9], [21, MAX]]);
  });

  it("omits the leading gap when the range starts at zero", () => {
    expect(negate([[0, 5]])).toEqual([[6, MAX]]);
  });

  it("omits the trailing gap when the range ends at the maximum", () => {
    expect(negate([[MAX - 1, MAX]])).toEqual([[0, MAX - 2]]);
  });

  it("is an involution on normalized lists", () => {
    fc.assert(
      fc.property(rangesArb, (ranges) => {
        const normalized = normalize(ranges);
        expect(normalize(negate(negate(normalized)))).toEqual(normalized);
      }),
    );
  });

  it("flips membership of every sampled code unit", () => {
    fc.assert(
      fc.property(rangesArb, fc.integer({ min: 0, max: MAX }), (ranges, code) => {
        const normalized = normalize(ranges);
        expect(contains(negate(normalized), code)).toBe(!contains(normalized, code));
      }),
    );
  });
});

describe("predefined classes", () => {
  it.each([
    ["DIGIT", DIGIT, /\d/],
    ["WORD", WORD, /\w/],
    ["SPACE", SPACE, /\s/],
  ])("%s agrees with the native class on every UTF-16 code unit", (_name, ranges, native) => {
    const mismatches: number[] = [];
    for (let code = 0; code <= MAX; code++) {
      if (contains(ranges, code) !== native.test(String.fromCharCode(code))) mismatches.push(code);
    }
    expect(mismatches).toEqual([]);
  });

  it.each([
    ["DIGIT", DIGIT],
    ["WORD", WORD],
    ["SPACE", SPACE],
  ])("%s is already normalized", (_name, ranges) => {
    expect(normalize(ranges)).toEqual(ranges);
  });
});

describe("contains", () => {
  const ranges: Ranges = [[10, 20], [30, 30], [100, 200]];

  it("is false for an empty list", () => {
    expect(contains([], 0)).toBe(false);
  });

  it("is true at both ends of a range", () => {
    expect(contains(ranges, 10)).toBe(true);
    expect(contains(ranges, 20)).toBe(true);
    expect(contains(ranges, 100)).toBe(true);
    expect(contains(ranges, 200)).toBe(true);
  });

  it("is false just outside a range", () => {
    expect(contains(ranges, 9)).toBe(false);
    expect(contains(ranges, 21)).toBe(false);
    expect(contains(ranges, 99)).toBe(false);
    expect(contains(ranges, 201)).toBe(false);
  });

  it("finds a single-element range", () => {
    expect(contains(ranges, 30)).toBe(true);
    expect(contains(ranges, 29)).toBe(false);
  });

  it("is false before the first and after the last range", () => {
    expect(contains(ranges, 0)).toBe(false);
    expect(contains(ranges, MAX)).toBe(false);
  });

  it("agrees with a linear scan", () => {
    fc.assert(
      fc.property(rangesArb, fc.integer({ min: 0, max: MAX }), (raw, code) => {
        const normalized = normalize(raw);
        expect(contains(normalized, code)).toBe(containsNaive(normalized, code));
      }),
      { numRuns: 1000 },
    );
  });
});
