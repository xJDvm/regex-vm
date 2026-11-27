/** An inclusive range of UTF-16 code units, `lo <= hi`. */
export type CodeRange = readonly [lo: number, hi: number];

/** A list of code-unit ranges. Lists produced by {@link normalize} are sorted and disjoint. */
export type Ranges = readonly CodeRange[];

/** Largest UTF-16 code unit; the universe used by {@link negate}. */
const MAX_CODE_UNIT = 0xffff;

/** Code units matched by `\d`: the ASCII digits `0`–`9`. */
export const DIGIT: Ranges = [[0x30, 0x39]];

/** Code units matched by `\w`: ASCII letters, digits and underscore. */
export const WORD: Ranges = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];

/**
 * Code units matched by `\s`: the JavaScript WhiteSpace and LineTerminator productions, that is
 * `\t \n \v \f \r`, the `Zs` space separators, `U+FEFF`, `U+2028` and `U+2029`.
 */
export const SPACE: Ranges = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

/**
 * Sorts ranges and merges overlapping or adjacent ones.
 *
 * @param ranges - Ranges with `lo <= hi`. The array is not modified.
 * @returns A new sorted list of disjoint, non-adjacent ranges.
 */
export function normalize(ranges: Ranges): CodeRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged;
}

/**
 * Complements a normalized range list over `[0, 0xFFFF]`.
 *
 * @param ranges - A list produced by {@link normalize}.
 * @returns The sorted, disjoint ranges that `ranges` does not cover.
 */
export function negate(ranges: Ranges): CodeRange[] {
  const out: CodeRange[] = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE_UNIT) out.push([next, MAX_CODE_UNIT]);
  return out;
}

/**
 * Tests whether a code unit lies in a normalized range list, using binary search.
 *
 * @param ranges - A list produced by {@link normalize}.
 * @param code - The UTF-16 code unit to look up.
 * @returns `true` when some range covers `code`.
 */
export function contains(ranges: Ranges, code: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid];
    if (range === undefined) return false;
    if (code < range[0]) {
      hi = mid - 1;
    } else if (code > range[1]) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}
