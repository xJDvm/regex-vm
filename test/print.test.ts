import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Class, Node } from "../src/ast.js";
import { normalize, type CodeRange } from "../src/charclass.js";
import { parse } from "../src/parser.js";
import { print } from "../src/print.js";
import { propertyOptions, zeroSpans } from "./arbitraries.js";

/** Parses `pattern`, prints the tree and checks that the printed text is exactly `expected`. */
function printsAs(pattern: string, expected: string): void {
  expect(print(parse(pattern).ast)).toBe(expected);
}

/** Round-trips `node` through print and parse and returns the reparsed tree, offsets removed. */
function roundTrip(node: Node): Node {
  return zeroSpans(parse(print(node)).ast);
}

describe("print: literal text", () => {
  it("prints a plain literal unchanged", () => {
    printsAs("abc", "abc");
  });

  it("escapes every syntax character so that it stands for itself", () => {
    printsAs(String.raw`\^\$\\\.\*\+\?\(\)\[\]\{\}\|\/\-`, String.raw`\^\$\\\.\*\+\?\(\)\[\]\{\}\|\/\-`);
  });

  it("writes a line feed as a hex escape", () => {
    printsAs("a\nb", String.raw`a\x0Ab`);
  });

  it("writes control escapes, NUL and high code units as hex escapes", () => {
    printsAs("\\t\\0\\xff\\u1234", "\\x09\\x00\\xFF\\u1234");
  });

  it("prints the dot and every assertion in their source form", () => {
    printsAs("^.$\\b\\B", String.raw`^.$\b\B`);
  });
});

describe("print: classes", () => {
  it("prints ranges and single code units", () => {
    printsAs("[a-cb]", "[a-c]");
    printsAs("[ac]", "[ac]");
  });

  it("prints negated classes", () => {
    printsAs("[^ab]", "[^a-b]");
    printsAs("[^ac]", "[^ac]");
  });

  it("prints the empty class and the negated empty class", () => {
    printsAs("[]", "[]");
    printsAs("[^]", "[^]");
  });

  it("prints predefined classes as their ranges", () => {
    printsAs(String.raw`\d`, "[0-9]");
    printsAs(String.raw`\D`, "[^0-9]");
  });

  it("escapes bracket, caret, dash and backslash members, merging adjacent ones into a range", () => {
    printsAs(String.raw`[\]\[\^\-\\]`, String.raw`[\-\[-\^]`);
  });
});

describe("print: groups, alternation and quantifiers", () => {
  it("prints each kind of group with its syntax", () => {
    printsAs("(a)", "(a)");
    printsAs("(?:a)", "(?:a)");
    printsAs("(?<name>a)", "(?<name>a)");
    printsAs("()", "()");
  });

  it("prints alternation with empty alternatives", () => {
    printsAs("a|", "a|");
    printsAs("|", "|");
    printsAs("a|b|c", "a|b|c");
  });

  it("prints each quantifier in its shortest spelling", () => {
    printsAs("a*", "a*");
    printsAs("a+", "a+");
    printsAs("a?", "a?");
    printsAs("a{0,1}", "a?");
    printsAs("a{2}", "a{2}");
    printsAs("a{2,}", "a{2,}");
    printsAs("a{2,5}", "a{2,5}");
    printsAs("a{0}", "a{0}");
  });

  it("prints lazy quantifiers with a trailing question mark", () => {
    printsAs("a*?", "a*?");
    printsAs("a+?", "a+?");
    printsAs("a??", "a??");
    printsAs("a{1,3}?", "a{1,3}?");
  });
});

describe("print: round trips over every code unit", () => {
  const codeUnit = fc.integer({ min: 0, max: 0xffff });

  it("reads back a literal atom of any code unit", () => {
    fc.assert(
      fc.property(codeUnit, (code) => {
        const node: Node = { type: "char", code, start: 0, end: 0 };
        expect(roundTrip(node)).toEqual(node);
      }),
      propertyOptions(),
    );
  });

  it("reads back a class built from arbitrary ranges of any code units", () => {
    const rangesArb = fc
      .array(fc.tuple(codeUnit, codeUnit), { maxLength: 6 })
      .map((pairs) => normalize(pairs.map(([a, b]): CodeRange => [Math.min(a, b), Math.max(a, b)])));
    fc.assert(
      fc.property(rangesArb, fc.boolean(), (ranges, negated) => {
        const node: Class = { type: "class", ranges, negated, start: 0, end: 0 };
        expect(roundTrip(node)).toEqual(node);
      }),
      propertyOptions(),
    );
  });
});
