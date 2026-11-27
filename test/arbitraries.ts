import fc from "fast-check";
import type { AssertKind, Node } from "../src/ast.js";
import { type CodeRange, normalize } from "../src/charclass.js";

/**
 * The part of Node's `process` that the test options read. Declared here because the Node typings are not a
 * dependency of this package.
 */
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/** Maximum height of a generated tree, counting leaves as height 1. */
export const MAX_TREE_HEIGHT = 4;

/** Number of cases per property test. */
const NUM_RUNS = 2000;

/** Code units of the generator alphabet: `a`, `b`, `c`, space and line feed. */
const ALPHABET: readonly number[] = [0x61, 0x62, 0x63, 0x20, 0x0a];

/** Placeholder offsets of generated nodes; comparisons go through {@link zeroSpans}. */
const SPAN = { start: 0, end: 0 } as const;

const EMPTY: Node = { type: "empty", ...SPAN };
const ASSERT_KINDS: readonly AssertKind[] = ["start", "end", "wordB", "notWordB"];

/** Repetition bounds drawn by the generator. */
interface Bounds {
  readonly min: number;
  readonly max: number;
}

/** The three capture styles a generated group can take. */
type GroupKind = "none" | "capture" | "named";

const literal = fc.constantFrom(...ALPHABET).map((code): Node => ({ type: "char", code, ...SPAN }));
const dot = fc.constant<Node>({ type: "any", ...SPAN });
const assertion = fc
  .constantFrom(...ASSERT_KINDS)
  .map((kind): Node => ({ type: "assert", kind, ...SPAN }));

const classNode = fc
  .record({
    pairs: fc.array(fc.tuple(fc.constantFrom(...ALPHABET), fc.constantFrom(...ALPHABET)), { maxLength: 3 }),
    negated: fc.boolean(),
  })
  .map(
    ({ pairs, negated }): Node => ({
      type: "class",
      ranges: normalize(pairs.map(([a, b]): CodeRange => [Math.min(a, b), Math.max(a, b)])),
      negated,
      ...SPAN,
    }),
  );

/** Leaves: literals, `.`, bracket expressions and assertions. */
const leaf: fc.Arbitrary<Node> = fc.oneof(literal, dot, classNode, assertion);

/** Atoms: the leaves that may be quantified, plus groups. */
const atomWithoutGroup: fc.Arbitrary<Node> = fc.oneof(literal, dot, classNode);

const bounds: fc.Arbitrary<Bounds> = fc.oneof(
  fc.constantFrom<Bounds>({ min: 0, max: Infinity }, { min: 1, max: Infinity }, { min: 0, max: 1 }),
  fc.integer({ min: 0, max: 3 }).map((n): Bounds => ({ min: n, max: n })),
  fc.integer({ min: 0, max: 3 }).map((n): Bounds => ({ min: n, max: Infinity })),
  fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 })).map(
    ([a, b]): Bounds => ({ min: Math.min(a, b), max: Math.max(a, b) }),
  ),
);

/** A term: a node that may appear as one item of a sequence (never empty, sequence or alternation). */
function termArb(depth: number): fc.Arbitrary<Node> {
  if (depth <= 1) return leaf;
  return fc.oneof(leaf, groupArb(depth), repeatArb(depth));
}

/** A quantifiable atom whose subtree height is at most `depth`. */
function atomArb(depth: number): fc.Arbitrary<Node> {
  if (depth <= 1) return atomWithoutGroup;
  return fc.oneof(atomWithoutGroup, groupArb(depth));
}

/** A quantified atom of height at most `depth`. */
function repeatArb(depth: number): fc.Arbitrary<Node> {
  return fc
    .record({ body: atomArb(depth - 1), bounds, greedy: fc.boolean() })
    .map(
      ({ body, bounds: { min, max }, greedy }): Node => ({ type: "repeat", body, min, max, greedy, ...SPAN }),
    );
}

/** A group of height at most `depth`; capture indices and names are placeholders until {@link numberGroups}. */
function groupArb(depth: number): fc.Arbitrary<Node> {
  return fc
    .record({ kind: fc.constantFrom<GroupKind>("none", "capture", "named"), body: nodeArb(depth - 1) })
    .map(
      ({ kind, body }): Node => ({
        type: "group",
        index: kind === "none" ? null : 0,
        name: kind === "named" ? "" : null,
        body,
        ...SPAN,
      }),
    );
}

/** A sequence of two or more terms, of height at most `depth`. */
function seqArb(depth: number): fc.Arbitrary<Node> {
  return fc
    .array(termArb(depth - 1), { minLength: 2, maxLength: 3 })
    .map((items): Node => ({ type: "seq", items, ...SPAN }));
}

/** One alternative of an alternation: possibly empty, but never itself an alternation. */
function alternativeArb(depth: number): fc.Arbitrary<Node> {
  if (depth <= 1) return fc.oneof(fc.constant(EMPTY), leaf);
  return fc.oneof(fc.constant(EMPTY), termArb(depth), seqArb(depth));
}

/** Two or three alternatives, of height at most `depth`. */
function altArb(depth: number): fc.Arbitrary<Node> {
  return fc
    .array(alternativeArb(depth - 1), { minLength: 2, maxLength: 3 })
    .map((alts): Node => ({ type: "alt", alts, ...SPAN }));
}

/** Any node of height at most `depth`, including the empty node and alternations. */
function nodeArb(depth: number): fc.Arbitrary<Node> {
  if (depth <= 1) return fc.oneof(fc.constant(EMPTY), leaf);
  return fc.oneof(fc.constant(EMPTY), termArb(depth), seqArb(depth), altArb(depth));
}

/**
 * Assigns capture indices and group names in source order, as the parser does: a group is numbered when its
 * opening parenthesis is read, so outer groups precede the groups nested in them. Named groups get the name
 * `g<index>`, which keeps names unique.
 *
 * @param root - A tree whose capturing groups carry a placeholder `index` and named groups a placeholder `name`.
 * @returns The same tree with real indices and names.
 */
export function numberGroups(root: Node): Node {
  let count = 0;
  const walk = (node: Node): Node => {
    switch (node.type) {
      case "seq":
        return { ...node, items: node.items.map(walk) };
      case "alt":
        return { ...node, alts: node.alts.map(walk) };
      case "repeat":
        return { ...node, body: walk(node.body) };
      case "group": {
        if (node.index === null) return { ...node, body: walk(node.body) };
        count += 1;
        const index = count;
        const name = node.name === null ? null : `g${index}`;
        return { ...node, index, name, body: walk(node.body) };
      }
      default:
        return node;
    }
  };
  return walk(root);
}

/**
 * Returns a copy of `node` with every source offset set to zero, so that trees from the generator and from
 * {@link parse} can be compared structurally.
 *
 * @param node - The tree to normalize.
 * @returns The same tree with `start` and `end` set to `0` at every node.
 */
export function zeroSpans(node: Node): Node {
  switch (node.type) {
    case "seq":
      return { ...node, items: node.items.map(zeroSpans), ...SPAN };
    case "alt":
      return { ...node, alts: node.alts.map(zeroSpans), ...SPAN };
    case "group":
    case "repeat":
      return { ...node, body: zeroSpans(node.body), ...SPAN };
    default:
      return { ...node, ...SPAN };
  }
}

/** Generated syntax trees of the supported subset, height at most {@link MAX_TREE_HEIGHT}. */
export const astArb: fc.Arbitrary<Node> = nodeArb(MAX_TREE_HEIGHT).map(numberGroups);

/**
 * Property-test options shared by the parser tests: {@link NUM_RUNS} cases, seeded from the `FC_SEED`
 * environment variable when it is set so that a failure can be replayed.
 *
 * @returns The `numRuns` and, when configured, `seed` parameters for `fc.assert`.
 * @throws {Error} When `FC_SEED` is set but is not a safe integer.
 */
export function propertyOptions(): Pick<fc.Parameters<never>, "numRuns" | "seed"> {
  const raw = process.env.FC_SEED;
  if (raw === undefined || raw === "") return { numRuns: NUM_RUNS };
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`FC_SEED must be a safe integer, got ${JSON.stringify(raw)}`);
  }
  return { numRuns: NUM_RUNS, seed };
}
