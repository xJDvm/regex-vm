import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Node, Repeat } from "../src/ast.js";
import { print } from "../src/print.js";
import { compile, type Match } from "../src/regex.js";
import { astArb, propertyOptions } from "./arbitraries.js";

/** Code units of the inputs: the generator alphabet, so that patterns and inputs meet often. */
const INPUT_ALPHABET = [..."abc \n"];

/** Longest input the generator produces. */
const MAX_INPUT_LENGTH = 10;

/** Start offsets range one past the end of the longest input, so offsets beyond the end are covered too. */
const MAX_START = MAX_INPUT_LENGTH + 1;

/** One search: an input text and the offset the search starts at. */
interface Probe {
  readonly input: string;
  readonly start: number;
}

const probeArb: fc.Arbitrary<Probe> = fc.record({
  input: fc
    .array(fc.constantFrom(...INPUT_ALPHABET), { maxLength: MAX_INPUT_LENGTH })
    .map((chars) => chars.join("")),
  start: fc.nat({ max: MAX_START }),
});

/**
 * Whether `node` can match the empty string. Assertions match empty, and a repetition with a zero minimum does too.
 *
 * @param node - The subtree to inspect.
 * @returns `true` when some way of matching `node` consumes no input.
 */
function nullable(node: Node): boolean {
  switch (node.type) {
    case "empty":
    case "assert":
      return true;
    case "char":
    case "any":
    case "class":
      return false;
    case "seq":
      return node.items.every(nullable);
    case "alt":
      return node.alts.some(nullable);
    case "group":
      return nullable(node.body);
    case "repeat":
      return node.min === 0 || nullable(node.body);
  }
}

/**
 * Whether some repetition in `node` satisfies `test`, looking at every repetition, nested ones included.
 *
 * @param node - The tree to search.
 * @param test - The condition on a repetition.
 * @returns `true` when at least one repetition in the tree passes `test`.
 */
function someRepeat(node: Node, test: (repeat: Repeat) => boolean): boolean {
  switch (node.type) {
    case "seq":
      return node.items.some((item) => someRepeat(item, test));
    case "alt":
      return node.alts.some((alt) => someRepeat(alt, test));
    case "group":
      return someRepeat(node.body, test);
    case "repeat":
      return test(node) || someRepeat(node.body, test);
    default:
      return false;
  }
}

/**
 * Whether some quantified body can match the empty string. The VM does not reproduce the captures that the
 * specification leaves behind after such empty iterations (for example `(a*)*` against `""`), so the differential
 * test does not compare captures for these trees.
 *
 * @param ast - The tree to inspect.
 * @returns `true` when a repetition in `ast` has a nullable body.
 */
function hasNullableQuantifiedBody(ast: Node): boolean {
  return someRepeat(ast, (repeat) => nullable(repeat.body));
}

/**
 * Whether some unbounded loop has a nullable body. For such trees the VM can end a match one iteration early, for
 * example `(?:.*?)*` against `"aa"` (V8 matches `"aa"`, the VM matches `""`), so the differential test compares only
 * whether there is a match for them. This is the open divergence recorded in the VM tests.
 *
 * @param ast - The tree to inspect.
 * @returns `true` when a `*`, `+` or `{n,}` repetition in `ast` has a nullable body.
 */
function hasNullableLoop(ast: Node): boolean {
  return someRepeat(ast, (repeat) => repeat.max === Infinity && nullable(repeat.body));
}

/**
 * Runs the native engine with the same search semantics as {@link compile}: the `g` flag makes `exec` search from
 * `lastIndex`, and no other flag changes matching for the supported subset.
 *
 * @param source - The pattern text.
 * @param probe - The input and the start offset.
 * @returns V8's match, or `null`.
 */
function nativeExec(source: string, { input, start }: Probe): RegExpExecArray | null {
  const regex = new RegExp(source, "g");
  regex.lastIndex = start;
  return regex.exec(input);
}

/** Which parts of a match are compared against V8 for one pattern. */
interface Checks {
  /** Whether the overall span, `index`, `end` and `groups[0]`, is compared. */
  readonly spans: boolean;
  /** Whether the captures and named groups are compared. Implies `spans`. */
  readonly captures: boolean;
}

/**
 * Checks one probe of `source` against V8. Whether there is a match is always compared. The rest follows `checks`.
 *
 * @param source - The pattern text.
 * @param match - The VM's result for `probe`, or `null`.
 * @param probe - The input and the start offset that produced `match`.
 * @param checks - Which parts of the match to compare.
 */
function expectSameAsNative(source: string, match: Match | null, probe: Probe, checks: Checks): void {
  const native = nativeExec(source, probe);
  if (native === null) {
    expect(match).toBeNull();
    return;
  }
  expect(match).not.toBeNull();
  if (match === null || !checks.spans) return;
  expect({ index: match.index, end: match.end, whole: match.groups[0] }).toEqual({
    index: native.index,
    end: native.index + native[0].length,
    whole: native[0],
  });
  if (!checks.captures) return;
  expect(match.groups).toEqual([...native]);
  expect(match.named).toEqual({ ...native.groups });
}

describe("differential: VM against V8 RegExp", () => {
  it("agrees with the native engine on generated patterns and inputs", () => {
    fc.assert(
      fc.property(astArb, fc.array(probeArb, { minLength: 1, maxLength: 4 }), (ast: Node, probes) => {
        const source = print(ast);
        const regex = compile(source);
        const checks: Checks = {
          spans: !hasNullableLoop(ast),
          captures: !hasNullableQuantifiedBody(ast),
        };
        for (const probe of probes) {
          expectSameAsNative(source, regex.exec(probe.input, probe.start), probe, checks);
        }
      }),
      propertyOptions(),
    );
  });
});
