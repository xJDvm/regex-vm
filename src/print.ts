import type { AssertKind, Class, Group, Node, Repeat } from "./ast.js";

/**
 * Characters that take a backslash in pattern text, so that `\c` denotes the character `c` itself. Every
 * character in this set is an identity escape accepted by the parser.
 */
const ESCAPABLE = "^$\\.*+?()[]{}|/-";

/** Pattern text of each zero-width assertion. */
const ASSERT_TEXT: Record<AssertKind, string> = {
  start: "^",
  end: "$",
  wordB: "\\b",
  notWordB: "\\B",
};

/**
 * Prints a syntax tree as pattern text. The text parses back to a tree equal to `ast` once source offsets are
 * ignored: `parse(print(ast))` is structurally equal to `ast`.
 *
 * The tree must have the shape that {@link parse} produces: sequences hold two or more terms (no nested
 * sequences, alternations or empty nodes), alternations hold two or more alternatives, and a repetition body is
 * an atom (a character, `.`, a class or a group). Such trees are printed in canonical form, for example `{0,1}`
 * is printed as `?`.
 *
 * @param ast - The syntax tree to print.
 * @returns Pattern source text, with metacharacters escaped and non-printable code units written as hex escapes.
 */
export function print(ast: Node): string {
  switch (ast.type) {
    case "empty":
      return "";
    case "char":
      return printCodeUnit(ast.code);
    case "any":
      return ".";
    case "class":
      return printClass(ast);
    case "seq":
      return ast.items.map(print).join("");
    case "alt":
      return ast.alts.map(print).join("|");
    case "group":
      return printGroup(ast);
    case "assert":
      return ASSERT_TEXT[ast.kind];
    case "repeat":
      return printRepeat(ast);
  }
}

/**
 * Prints one code unit as a literal atom or class member. Escapable characters get a backslash, printable ASCII
 * stands for itself, and everything else is written as `\xHH` or `\uHHHH`.
 */
function printCodeUnit(code: number): string {
  const ch = String.fromCharCode(code);
  if (ESCAPABLE.includes(ch)) return `\\${ch}`;
  if (code >= 0x20 && code <= 0x7e) return ch;
  if (code <= 0xff) return `\\x${hex(code, 2)}`;
  return `\\u${hex(code, 4)}`;
}

/** Prints a bracket expression, writing each range as `lo-hi` or as a single code unit when `lo === hi`. */
function printClass(node: Class): string {
  const body = node.ranges
    .map(([lo, hi]) => (lo === hi ? printCodeUnit(lo) : `${printCodeUnit(lo)}-${printCodeUnit(hi)}`))
    .join("");
  return `[${node.negated ? "^" : ""}${body}]`;
}

/** Prints a group with the syntax that yields its capture index and name: `(?:`, `(` or `(?<name>`. */
function printGroup(node: Group): string {
  let open = "(?:";
  if (node.index !== null) {
    open = node.name === null ? "(" : `(?<${node.name}>`;
  }
  return `${open}${print(node.body)})`;
}

/** Prints a quantified atom followed by its quantifier, and a `?` when it is lazy. */
function printRepeat(node: Repeat): string {
  const lazy = node.greedy ? "" : "?";
  return `${print(node.body)}${printQuantifier(node.min, node.max)}${lazy}`;
}

/** Chooses the shortest quantifier spelling for the bounds: `*`, `+`, `?`, `{n}`, `{n,}` or `{n,m}`. */
function printQuantifier(min: number, max: number): string {
  if (max === Infinity) {
    if (min === 0) return "*";
    if (min === 1) return "+";
    return `{${min},}`;
  }
  if (min === 0 && max === 1) return "?";
  return min === max ? `{${min}}` : `{${min},${max}}`;
}

/** Formats `value` as upper-case hexadecimal, left-padded with zeros to `width` digits. */
function hex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, "0");
}
