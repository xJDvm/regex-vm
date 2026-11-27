import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Node } from "../src/ast.js";
import { RegexSyntaxError } from "../src/errors.js";
import { parse } from "../src/parser.js";
import { print } from "../src/print.js";
import { astArb, MAX_TREE_HEIGHT, propertyOptions, zeroSpans } from "./arbitraries.js";

/** Characters that carry meaning in pattern syntax, plus letters and digits that complete escapes. */
const SYNTAX_CHARS = [..."()[]{}|*+?.^$\\/-:,<>=!bdswDSWB0123456789 aknxuc\n"];

/** Arbitrary pattern text: any UTF-16 code units, mixed with syntax-heavy text that reaches deeper parser paths. */
const patternArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.array(fc.constantFrom(...SYNTAX_CHARS), { maxLength: 40 }).map((chars) => chars.join("")),
);

/** Returns whether `parse` accepts `pattern`; rethrows anything other than a {@link RegexSyntaxError}. */
function accepts(pattern: string): boolean {
  try {
    parse(pattern);
    return true;
  } catch (error) {
    if (error instanceof RegexSyntaxError) return false;
    throw error;
  }
}

/** Depth of a tree, where a leaf has depth 1. */
function height(node: Node): number {
  switch (node.type) {
    case "seq":
      return 1 + Math.max(...node.items.map(height));
    case "alt":
      return 1 + Math.max(...node.alts.map(height));
    case "group":
    case "repeat":
      return 1 + height(node.body);
    default:
      return 1;
  }
}

describe("parse and print", () => {
  it("reads back every printed generated tree, ignoring offsets", () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        expect(zeroSpans(parse(print(ast)).ast)).toEqual(zeroSpans(ast));
      }),
      propertyOptions(),
    );
  });

  it("generates trees no taller than the design's depth limit", () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        expect(height(ast)).toBeLessThanOrEqual(MAX_TREE_HEIGHT);
      }),
      propertyOptions(),
    );
  });
});

describe("parse: arbitrary input", () => {
  it("either returns a tree or throws only RegexSyntaxError, located inside the pattern", () => {
    fc.assert(
      fc.property(patternArb, (pattern) => {
        try {
          parse(pattern);
        } catch (error) {
          if (!(error instanceof RegexSyntaxError)) throw error;
          expect(error.position).toBeLessThanOrEqual(pattern.length);
        }
      }),
      propertyOptions(),
    );
  });

  it("accepts a pattern only when the native RegExp accepts it", () => {
    fc.assert(
      fc.property(patternArb, (pattern) => {
        if (accepts(pattern)) {
          expect(() => new RegExp(pattern)).not.toThrow();
        }
      }),
      propertyOptions(),
    );
  });
});
