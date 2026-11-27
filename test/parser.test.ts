import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Node, Span } from "../src/ast.js";
import { RegexSyntaxError } from "../src/errors.js";
import { parse } from "../src/parser.js";

/** Expected single-character literal node spanning `[start, start + 1)`. */
const char = (ch: string, start: number): Node => ({
  type: "char",
  code: ch.charCodeAt(0),
  start,
  end: start + 1,
});

/** Returns the error thrown by `parse(pattern)`, failing the test if none is thrown. */
function errorOf(pattern: string): RegexSyntaxError {
  try {
    parse(pattern);
  } catch (error) {
    if (error instanceof RegexSyntaxError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(pattern)} to be rejected`);
}

/** Child nodes of a node, in source order. */
function childrenOf(node: Node): readonly Node[] {
  switch (node.type) {
    case "seq":
      return node.items;
    case "alt":
      return node.alts;
    case "group":
      return [node.body];
    default:
      return [];
  }
}

/** Asserts that spans are well ordered, nested inside their parent, and that siblings do not overlap. */
function assertSpans(node: Node, parent: Span | undefined, length: number): void {
  expect(node.start).toBeGreaterThanOrEqual(0);
  expect(node.start).toBeLessThanOrEqual(node.end);
  expect(node.end).toBeLessThanOrEqual(length);
  if (parent !== undefined) {
    expect(node.start).toBeGreaterThanOrEqual(parent.start);
    expect(node.end).toBeLessThanOrEqual(parent.end);
  }
  let previous: Node | undefined;
  for (const child of childrenOf(node)) {
    if (previous !== undefined) expect(child.start).toBeGreaterThanOrEqual(previous.end);
    assertSpans(child, node, length);
    previous = child;
  }
}

describe("parse: accepted syntax", () => {
  it("parses the empty pattern as an empty node", () => {
    expect(parse("")).toEqual({ ast: { type: "empty", start: 0, end: 0 }, groupCount: 0, groupNames: new Map() });
  });

  it("parses a single literal", () => {
    expect(parse("a").ast).toEqual(char("a", 0));
  });

  it("parses a concatenation with offsets", () => {
    expect(parse("abc").ast).toEqual({
      type: "seq",
      items: [char("a", 0), char("b", 1), char("c", 2)],
      start: 0,
      end: 3,
    });
  });

  it("treats each UTF-16 code unit of a surrogate pair as a separate literal", () => {
    expect(parse("\u{1F600}").ast).toEqual({
      type: "seq",
      items: [
        { type: "char", code: 0xd83d, start: 0, end: 1 },
        { type: "char", code: 0xde00, start: 1, end: 2 },
      ],
      start: 0,
      end: 2,
    });
  });

  it("parses the any-character atom", () => {
    expect(parse(".").ast).toEqual({ type: "any", start: 0, end: 1 });
  });

  it("parses start and end assertions", () => {
    expect(parse("^$").ast).toEqual({
      type: "seq",
      items: [
        { type: "assert", kind: "start", start: 0, end: 1 },
        { type: "assert", kind: "end", start: 1, end: 2 },
      ],
      start: 0,
      end: 2,
    });
  });

  it.each([
    ["\\.", 46],
    ["\\*", 42],
    ["\\+", 43],
    ["\\?", 63],
    ["\\(", 40],
    ["\\)", 41],
    ["\\[", 91],
    ["\\]", 93],
    ["\\{", 123],
    ["\\}", 125],
    ["\\|", 124],
    ["\\^", 94],
    ["\\$", 36],
    ["\\\\", 92],
    ["\\/", 47],
    ["\\-", 45],
  ])("treats %s as the literal code unit %i", (pattern, code) => {
    expect(parse(pattern).ast).toEqual({ type: "char", code, start: 0, end: 2 });
  });

  it("parses a two-way alternation", () => {
    expect(parse("a|b").ast).toEqual({
      type: "alt",
      alts: [char("a", 0), char("b", 2)],
      start: 0,
      end: 3,
    });
  });

  it("parses an alternation with an empty trailing alternative", () => {
    expect(parse("a|").ast).toEqual({
      type: "alt",
      alts: [char("a", 0), { type: "empty", start: 2, end: 2 }],
      start: 0,
      end: 2,
    });
  });

  it("parses a lone bar as two empty alternatives", () => {
    expect(parse("|").ast).toEqual({
      type: "alt",
      alts: [
        { type: "empty", start: 0, end: 0 },
        { type: "empty", start: 1, end: 1 },
      ],
      start: 0,
      end: 1,
    });
  });

  it("keeps every empty alternative when bars repeat", () => {
    const { ast } = parse("||");
    expect(ast).toEqual({
      type: "alt",
      alts: [
        { type: "empty", start: 0, end: 0 },
        { type: "empty", start: 1, end: 1 },
        { type: "empty", start: 2, end: 2 },
      ],
      start: 0,
      end: 2,
    });
  });

  it("binds alternation looser than concatenation", () => {
    expect(parse("ab|c").ast).toEqual({
      type: "alt",
      alts: [
        { type: "seq", items: [char("a", 0), char("b", 1)], start: 0, end: 2 },
        char("c", 3),
      ],
      start: 0,
      end: 4,
    });
  });

  it("parses an empty capturing group", () => {
    expect(parse("()")).toEqual({
      ast: {
        type: "group",
        index: 1,
        name: null,
        body: { type: "empty", start: 1, end: 1 },
        start: 0,
        end: 2,
      },
      groupCount: 1,
      groupNames: new Map(),
    });
  });

  it("parses a non-capturing group without an index", () => {
    expect(parse("(?:a)").ast).toEqual({
      type: "group",
      index: null,
      name: null,
      body: char("a", 3),
      start: 0,
      end: 5,
    });
  });

  it("parses a named group and records its name", () => {
    expect(parse("(?<n>a)")).toEqual({
      ast: { type: "group", index: 1, name: "n", body: char("a", 5), start: 0, end: 7 },
      groupCount: 1,
      groupNames: new Map([["n", 1]]),
    });
  });

  it("numbers nested capturing groups by their opening parenthesis", () => {
    const { ast, groupCount } = parse("((a))");
    expect(groupCount).toBe(2);
    expect(ast).toEqual({
      type: "group",
      index: 1,
      name: null,
      body: {
        type: "group",
        index: 2,
        name: null,
        body: char("a", 2),
        start: 1,
        end: 4,
      },
      start: 0,
      end: 5,
    });
  });

  it("counts sibling capturing groups", () => {
    expect(parse("(a)(b)").groupCount).toBe(2);
  });

  it("numbers capturing groups inside a non-capturing group", () => {
    const { ast, groupCount } = parse("(?:(a)|b)");
    expect(groupCount).toBe(1);
    expect(ast).toEqual({
      type: "group",
      index: null,
      name: null,
      body: {
        type: "alt",
        alts: [
          { type: "group", index: 1, name: null, body: char("a", 4), start: 3, end: 6 },
          char("b", 7),
        ],
        start: 3,
        end: 8,
      },
      start: 0,
      end: 9,
    });
  });

  it("parses an alternation whose alternatives are both empty", () => {
    expect(parse("(|)").ast).toEqual({
      type: "group",
      index: 1,
      name: null,
      body: {
        type: "alt",
        alts: [
          { type: "empty", start: 1, end: 1 },
          { type: "empty", start: 2, end: 2 },
        ],
        start: 1,
        end: 2,
      },
      start: 0,
      end: 3,
    });
  });

  it("parses a plain class and merges its ranges", () => {
    expect(parse("[abc]").ast).toEqual({ type: "class", ranges: [[97, 99]], negated: false, start: 0, end: 5 });
  });

  it("parses a class range", () => {
    expect(parse("[a-z]").ast).toEqual({ type: "class", ranges: [[97, 122]], negated: false, start: 0, end: 5 });
  });

  it("merges overlapping ranges inside a class", () => {
    expect(parse("[a-cb-d]").ast).toEqual({ type: "class", ranges: [[97, 100]], negated: false, start: 0, end: 8 });
  });

  it("parses a single-code-unit range", () => {
    expect(parse("[a-a]").ast).toEqual({ type: "class", ranges: [[97, 97]], negated: false, start: 0, end: 5 });
  });

  it("parses an empty class as matching nothing", () => {
    expect(parse("[]").ast).toEqual({ type: "class", ranges: [], negated: false, start: 0, end: 2 });
  });

  it("parses an inverted empty class as matching everything", () => {
    expect(parse("[^]").ast).toEqual({ type: "class", ranges: [], negated: true, start: 0, end: 3 });
  });

  it("parses a negated class", () => {
    expect(parse("[^a]").ast).toEqual({ type: "class", ranges: [[97, 97]], negated: true, start: 0, end: 4 });
  });

  it("treats a dash at either edge of a class as a literal", () => {
    const ranges = [
      [45, 45],
      [97, 97],
    ];
    expect(parse("[a-]").ast).toMatchObject({ type: "class", ranges });
    expect(parse("[-a]").ast).toMatchObject({ type: "class", ranges });
  });

  it("parses escaped class members", () => {
    expect(parse("[\\]\\-]").ast).toMatchObject({ type: "class", ranges: [[45, 45], [93, 93]] });
    expect(parse("[\\\\]").ast).toMatchObject({ type: "class", ranges: [[92, 92]] });
  });

  it("accepts a range whose lower endpoint is an escape", () => {
    expect(parse("[\\--a]").ast).toMatchObject({ type: "class", ranges: [[45, 97]] });
  });

  it("accepts brackets and dots literally inside a class", () => {
    expect(parse("[.[]").ast).toMatchObject({ type: "class", ranges: [[46, 46], [91, 91]] });
  });

  it("accepts the maximum of 1 000 capture groups", () => {
    expect(parse("()".repeat(1000)).groupCount).toBe(1000);
  });

  it("accepts nesting exactly at the maximum depth of 500", () => {
    expect(parse("(".repeat(500) + ")".repeat(500)).groupCount).toBe(500);
  });

  it("accepts a pattern of exactly 10 000 code units", () => {
    expect(parse("a".repeat(10_000)).ast).toMatchObject({ type: "seq", start: 0, end: 10_000 });
  });

  it("spans the whole pattern at the root", () => {
    for (const pattern of ["", "a|b", "(a)(?<x>b)", "[a-z]|^$"]) {
      expect(parse(pattern).ast).toMatchObject({ start: 0, end: pattern.length });
    }
  });
});

describe("parse: rejected syntax", () => {
  it.each([
    ["(", "unterminated group", 0],
    ["(a", "unterminated group", 0],
    ["((a)", "unterminated group", 0],
    ["(?:a", "unterminated group", 0],
    [")", "unmatched ')'", 0],
    ["a)", "unmatched ')'", 1],
    ["[", "unterminated character class", 0],
    ["[a", "unterminated character class", 0],
    ["[a-", "unterminated character class", 0],
    ["[^", "unterminated character class", 0],
    ["[z-a]", "range out of order in character class", 1],
    ["[a-\\d]", "unsupported escape '\\d'", 3],
    ["*", "quantifiers are not supported yet", 0],
    ["a*", "quantifiers are not supported yet", 1],
    ["a+", "quantifiers are not supported yet", 1],
    ["a?", "quantifiers are not supported yet", 1],
    ["a{2}", "quantifiers are not supported yet", 1],
    ["{", "quantifiers are not supported yet", 0],
    ["}", "unmatched '}'", 0],
    ["a}", "unmatched '}'", 1],
    ["]", "unmatched ']'", 0],
    ["\\", "\\ at end of pattern", 0],
    ["a\\", "\\ at end of pattern", 1],
    ["\\d", "unsupported escape '\\d'", 0],
    ["\\b", "unsupported escape '\\b'", 0],
    ["\\1", "unsupported escape '\\1'", 0],
    ["\\n", "unsupported escape '\\n'", 0],
    ["(?=a)", "lookaround is not supported", 0],
    ["(?!a)", "lookaround is not supported", 0],
    ["a(?=b)", "lookaround is not supported", 1],
    ["(?<=a)", "lookbehind is not supported", 0],
    ["(?<!a)", "lookbehind is not supported", 0],
    ["(?x)", "invalid group", 0],
    ["(?", "invalid group", 0],
    ["(?<>a)", "invalid group name", 0],
    ["(?<1a>b)", "invalid group name", 0],
    ["(?<a b>c)", "invalid group name", 0],
    ["(?<a", "invalid group name", 0],
    ["(?<a>x)(?<a>y)", "duplicate group name 'a'", 7],
  ])("rejects %j with %j", (pattern, what, position) => {
    const error = errorOf(pattern);
    expect(error).toBeInstanceOf(RegexSyntaxError);
    expect(error.message).toBe(`${what} at position ${position}`);
    expect(error.position).toBe(position);
  });

  it("rejects group nesting one level beyond the maximum, at the offending parenthesis", () => {
    const pattern = "(".repeat(501) + ")".repeat(501);
    expect(errorOf(pattern)).toMatchObject({ message: "group nesting too deep at position 500", position: 500 });
  });

  it("rejects the 1 001st capture group at its parenthesis", () => {
    const error = errorOf("()".repeat(1001));
    expect(error).toMatchObject({ message: "too many capture groups at position 2000", position: 2000 });
  });

  it("rejects a pattern one code unit beyond the length limit at position 10 000", () => {
    const error = errorOf("a".repeat(10_001));
    expect(error).toMatchObject({ message: "pattern too long at position 10000", position: 10_000 });
  });

  it("is an instance of SyntaxError with its own name", () => {
    const error = errorOf("(");
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error.name).toBe("RegexSyntaxError");
  });
});

describe("parse: properties", () => {
  const alphabet = ["a", "b", "(", ")", "[", "]", "|", "^", "$", ".", "-", "\\", "?", "<", ">", ":", "=", "!", "*", "+", "{", "}", "n", "_", "/", "1"];

  it("either returns valid spans or throws a positioned RegexSyntaxError, and accepted patterns are valid RegExp", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 40 }).map((chars) => chars.join("")), (pattern) => {
        let result: ReturnType<typeof parse>;
        try {
          result = parse(pattern);
        } catch (error) {
          expect(error).toBeInstanceOf(RegexSyntaxError);
          if (!(error instanceof RegexSyntaxError)) throw error;
          expect(error.position).toBeGreaterThanOrEqual(0);
          expect(error.position).toBeLessThanOrEqual(pattern.length);
          return;
        }
        expect(() => new RegExp(pattern)).not.toThrow();
        assertSpans(result.ast, undefined, pattern.length);
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws anything but RegexSyntaxError for arbitrary unicode strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (pattern) => {
        try {
          parse(pattern);
        } catch (error) {
          expect(error).toBeInstanceOf(RegexSyntaxError);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
