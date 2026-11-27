import type { Node } from "./ast.js";
import { type CodeRange, DIGIT, negate, normalize, type Ranges, SPACE, WORD } from "./charclass.js";
import { RegexSyntaxError } from "./errors.js";

/** Result of {@link parse}. */
export interface ParseResult {
  /** Root of the syntax tree. */
  readonly ast: Node;
  /** Number of capturing groups; the whole match is not counted. */
  readonly groupCount: number;
  /** Maps each group name to its 1-based capture index. */
  readonly groupNames: Map<string, number>;
}

const MAX_PATTERN_LENGTH = 10_000;
const MAX_GROUP_DEPTH = 500;
const MAX_CAPTURE_GROUPS = 1_000;
/** Largest bound accepted in a counted repetition `{n}`, `{n,}` or `{n,m}`. */
const MAX_COUNTED_REPETITION = 1_000;

/** Code unit denoted by `\b` inside a character class (backspace). */
const BACKSPACE = 0x08;

/** Characters that may follow a backslash to denote themselves. */
const IDENTITY_ESCAPES = "^$\\.*+?()[]{}|/-";
/** Control escapes `\f \n \r \t \v`, mapped to their code units. */
const CONTROL_ESCAPES = new Map<string, number>([
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["v", 0x0b],
]);
/** Predefined class escapes: `negated` marks the upper-case forms, which match the complement of `ranges`. */
const CLASS_ESCAPES = new Map<string, { readonly ranges: Ranges; readonly negated: boolean }>([
  ["d", { ranges: DIGIT, negated: false }],
  ["D", { ranges: DIGIT, negated: true }],
  ["w", { ranges: WORD, negated: false }],
  ["W", { ranges: WORD, negated: true }],
  ["s", { ranges: SPACE, negated: false }],
  ["S", { ranges: SPACE, negated: true }],
]);
const GROUP_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const GROUP_NAME_CHAR = /^[A-Za-z0-9_$]$/;
/** Matches `{n}`, `{n,}` or `{n,m}` at `lastIndex`; sticky, so the search never scans past the brace. */
const COUNTED_REPETITION = /\{(\d+)(?:,(\d*))?\}/y;
const HEX_DIGITS = /^[0-9A-Fa-f]+$/;
const ASCII_LETTER = /^[A-Za-z]$/;
const DECIMAL_DIGIT = /^[0-9]$/;
/** Escape letters that start a backreference outside a character class. */
const BACKREFERENCE_START = /^[1-9k]$/;

/** Repetition bounds of a quantifier: `max` is `Infinity` when unbounded. */
interface Bounds {
  readonly min: number;
  readonly max: number;
}

/** A quantifier with its laziness. */
interface Quantifier extends Bounds {
  readonly greedy: boolean;
}

/**
 * One item of a character class: either a single code unit, or a set of ranges produced by a predefined class
 * escape such as `\d`.
 */
type ClassAtom = { readonly kind: "code"; readonly code: number } | { readonly kind: "set"; readonly ranges: Ranges };

/**
 * Parses a pattern into a syntax tree.
 *
 * Every node records its source span. Backreferences, lookaround, Annex-B leniencies and any escape not listed
 * in the design are rejected with a {@link RegexSyntaxError} carrying the offending position.
 *
 * @param pattern - The pattern source, at most 10 000 code units.
 * @returns The syntax tree and group metadata.
 * @throws {RegexSyntaxError} When the pattern is invalid or exceeds a limit.
 */
export function parse(pattern: string): ParseResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new RegexSyntaxError("pattern too long", MAX_PATTERN_LENGTH);
  }
  const parser = new Parser(pattern);
  const ast = parser.parseDisjunction();
  if (parser.pos < pattern.length) {
    throw new RegexSyntaxError("unmatched ')'", parser.pos);
  }
  return { ast, groupCount: parser.groupCount, groupNames: parser.groupNames };
}

/** Recursive-descent parser state. Nesting is bounded by {@link MAX_GROUP_DEPTH}. */
class Parser {
  /** Offset of the next unread code unit. */
  pos = 0;
  /** Number of capturing groups opened so far. */
  groupCount = 0;
  readonly groupNames = new Map<string, number>();
  private depth = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  /** Returns the code unit `offset` positions ahead, or `""` past the end. */
  peek(offset = 0): string {
    return this.src.charAt(this.pos + offset);
  }

  /** `Disjunction := Alternative ('|' Alternative)*` */
  parseDisjunction(): Node {
    const first = this.parseAlternative();
    if (this.peek() !== "|") return first;
    const alts: Node[] = [first];
    while (this.peek() === "|") {
      this.pos += 1;
      alts.push(this.parseAlternative());
    }
    return { type: "alt", alts, start: first.start, end: this.pos };
  }

  /** `Alternative := Term*`; an empty alternative yields a node of type `empty`. */
  private parseAlternative(): Node {
    const start = this.pos;
    const items: Node[] = [];
    while (this.pos < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      items.push(this.parseTerm());
    }
    const [first, ...rest] = items;
    if (first === undefined) return { type: "empty", start, end: start };
    if (rest.length === 0) return first;
    return { type: "seq", items, start, end: this.pos };
  }

  /** `Term := Atom Quantifier?`; quantifying an assertion is an error. */
  private parseTerm(): Node {
    const atom = this.parseAtom();
    const quantifierStart = this.pos;
    const quantifier = this.parseQuantifier();
    if (quantifier === null) return atom;
    if (atom.type === "assert") throw new RegexSyntaxError("nothing to repeat", quantifierStart);
    return {
      type: "repeat",
      body: atom,
      min: quantifier.min,
      max: quantifier.max,
      greedy: quantifier.greedy,
      start: atom.start,
      end: this.pos,
    };
  }

  /** `Quantifier := ('*' | '+' | '?' | Counted) '?'?`; returns `null` when no quantifier starts here. */
  private parseQuantifier(): Quantifier | null {
    const bounds = this.parseBounds();
    if (bounds === null) return null;
    const greedy = this.peek() !== "?";
    if (!greedy) this.pos += 1;
    return { min: bounds.min, max: bounds.max, greedy };
  }

  /** Consumes a quantifier's bounds (without laziness) and returns them, or `null` if none starts here. */
  private parseBounds(): Bounds | null {
    switch (this.peek()) {
      case "*":
        this.pos += 1;
        return { min: 0, max: Infinity };
      case "+":
        this.pos += 1;
        return { min: 1, max: Infinity };
      case "?":
        this.pos += 1;
        return { min: 0, max: 1 };
      case "{":
        return this.parseCountedRepetition();
      default:
        return null;
    }
  }

  /**
   * Parses `{n}`, `{n,}` or `{n,m}` at the current position, enforcing {@link MAX_COUNTED_REPETITION}.
   *
   * @returns The bounds, or `null` (consuming nothing) when the text is not a counted repetition.
   * @throws {RegexSyntaxError} At the `{` when a bound is too large or `m` is less than `n`.
   */
  private parseCountedRepetition(): Bounds | null {
    const start = this.pos;
    COUNTED_REPETITION.lastIndex = start;
    const match = COUNTED_REPETITION.exec(this.src);
    if (match === null) return null;
    const min = Number(match[1]);
    const hasComma = match[2] !== undefined;
    const unbounded = hasComma && match[2] === "";
    const max = hasComma ? (unbounded ? Infinity : Number(match[2])) : min;
    if (min > MAX_COUNTED_REPETITION || (!unbounded && max > MAX_COUNTED_REPETITION)) {
      throw new RegexSyntaxError("repetition bound too large", start);
    }
    if (max < min) throw new RegexSyntaxError("numbers out of order in quantifier", start);
    this.pos += match[0].length;
    return { min, max };
  }

  /** `Atom := Group | Class | Escape | '.' | '^' | '$' | literal` */
  private parseAtom(): Node {
    const start = this.pos;
    switch (this.peek()) {
      case "(":
        return this.parseGroup();
      case "[":
        return this.parseClass();
      case "\\":
        return this.parseEscapeAtom();
      case ".":
        this.pos += 1;
        return { type: "any", start, end: this.pos };
      case "^":
        this.pos += 1;
        return { type: "assert", kind: "start", start, end: this.pos };
      case "$":
        this.pos += 1;
        return { type: "assert", kind: "end", start, end: this.pos };
      case "*":
      case "+":
      case "?":
        throw new RegexSyntaxError("nothing to repeat", start);
      case "{": {
        const repetition = this.parseCountedRepetition();
        throw new RegexSyntaxError(repetition === null ? "unmatched '{'" : "nothing to repeat", start);
      }
      case "}":
      case "]":
        throw new RegexSyntaxError(`unmatched '${this.peek()}'`, start);
      default:
        this.pos += 1;
        return { type: "char", code: this.src.charCodeAt(start), start, end: this.pos };
    }
  }

  /** `Group := '(' ('?:' | '?<' name '>')? Disjunction ')'` */
  private parseGroup(): Node {
    const start = this.pos;
    if (this.depth >= MAX_GROUP_DEPTH) {
      throw new RegexSyntaxError("group nesting too deep", start);
    }
    this.pos += 1;
    let index: number | null = null;
    let name: string | null = null;
    if (this.peek() === "?") {
      const kind = this.peek(1);
      if (kind === ":") {
        this.pos += 2;
      } else if (kind === "=" || kind === "!") {
        throw new RegexSyntaxError("lookaround is not supported", start);
      } else if (kind === "<") {
        if (this.peek(2) === "=" || this.peek(2) === "!") {
          throw new RegexSyntaxError("lookbehind is not supported", start);
        }
        name = this.parseGroupName(start);
        index = this.openCapture(name, start);
      } else {
        throw new RegexSyntaxError("invalid group", start);
      }
    } else {
      index = this.openCapture(null, start);
    }
    this.depth += 1;
    const body = this.parseDisjunction();
    this.depth -= 1;
    if (this.peek() !== ")") {
      throw new RegexSyntaxError("unterminated group", start);
    }
    this.pos += 1;
    return { type: "group", index, name, body, start, end: this.pos };
  }

  /** Reads `?<name>` at the current position and returns the name. */
  private parseGroupName(groupStart: number): string {
    this.pos += 2;
    const nameStart = this.pos;
    while (GROUP_NAME_CHAR.test(this.peek())) this.pos += 1;
    const name = this.src.slice(nameStart, this.pos);
    if (!GROUP_NAME.test(name) || this.peek() !== ">") {
      throw new RegexSyntaxError("invalid group name", groupStart);
    }
    this.pos += 1;
    return name;
  }

  /** Assigns the next capture index and records the name, if any. */
  private openCapture(name: string | null, groupStart: number): number {
    this.groupCount += 1;
    if (this.groupCount > MAX_CAPTURE_GROUPS) {
      throw new RegexSyntaxError("too many capture groups", groupStart);
    }
    if (name !== null) {
      if (this.groupNames.has(name)) {
        throw new RegexSyntaxError(`duplicate group name '${name}'`, groupStart);
      }
      this.groupNames.set(name, this.groupCount);
    }
    return this.groupCount;
  }

  /** `Class := '[' '^'? ClassAtom ('-' ClassAtom)? ... ']'` */
  private parseClass(): Node {
    const start = this.pos;
    this.pos += 1;
    const negated = this.peek() === "^";
    if (negated) this.pos += 1;
    const ranges: CodeRange[] = [];
    while (this.peek() !== "]") {
      if (this.pos >= this.src.length) {
        throw new RegexSyntaxError("unterminated character class", start);
      }
      const atomStart = this.pos;
      const lo = this.parseClassAtom();
      const isRange = this.peek() === "-" && this.peek(1) !== "" && this.peek(1) !== "]";
      if (!isRange) {
        pushAtom(ranges, lo);
        continue;
      }
      if (lo.kind === "set") {
        throw new RegexSyntaxError("class escape cannot start a range", atomStart);
      }
      this.pos += 1;
      const hiStart = this.pos;
      const hi = this.parseClassAtom();
      if (hi.kind === "set") {
        throw new RegexSyntaxError("class escape cannot end a range", hiStart);
      }
      if (lo.code > hi.code) {
        throw new RegexSyntaxError("range out of order in character class", atomStart);
      }
      ranges.push([lo.code, hi.code]);
    }
    this.pos += 1;
    return { type: "class", ranges: normalize(ranges), negated, start, end: this.pos };
  }

  /** Consumes one class item: a literal code unit, `\b` (backspace), a predefined class or a character escape. */
  private parseClassAtom(): ClassAtom {
    if (this.peek() !== "\\") {
      const code = this.src.charCodeAt(this.pos);
      this.pos += 1;
      return { kind: "code", code };
    }
    const escaped = this.peek(1);
    if (escaped === "b") {
      this.pos += 2;
      return { kind: "code", code: BACKSPACE };
    }
    const predefined = CLASS_ESCAPES.get(escaped);
    if (predefined !== undefined) {
      this.pos += 2;
      return { kind: "set", ranges: predefined.negated ? negate(predefined.ranges) : predefined.ranges };
    }
    return { kind: "code", code: this.parseCharEscape() };
  }

  /** Parses an escape outside a class: `\b`, `\B`, a predefined class, or a character escape. */
  private parseEscapeAtom(): Node {
    const start = this.pos;
    const escaped = this.peek(1);
    if (escaped === "b" || escaped === "B") {
      this.pos += 2;
      return { type: "assert", kind: escaped === "b" ? "wordB" : "notWordB", start, end: this.pos };
    }
    if (BACKREFERENCE_START.test(escaped)) {
      throw new RegexSyntaxError("backreferences are not supported", start);
    }
    const predefined = CLASS_ESCAPES.get(escaped);
    if (predefined !== undefined) {
      this.pos += 2;
      return { type: "class", ranges: predefined.ranges, negated: predefined.negated, start, end: this.pos };
    }
    const code = this.parseCharEscape();
    return { type: "char", code, start, end: this.pos };
  }

  /**
   * Parses a character escape at the current backslash and returns the code unit it denotes: a control escape,
   * `\0`, `\cX`, `\xHH`, `\uHHHH`, or an identity escape of a syntax character.
   */
  private parseCharEscape(): number {
    const start = this.pos;
    if (start + 1 >= this.src.length) {
      throw new RegexSyntaxError("\\ at end of pattern", start);
    }
    const escaped = this.src.charAt(start + 1);
    this.pos += 2;
    const control = CONTROL_ESCAPES.get(escaped);
    if (control !== undefined) return control;
    switch (escaped) {
      case "0":
        if (DECIMAL_DIGIT.test(this.peek())) {
          throw new RegexSyntaxError("legacy octal escape is not supported", start);
        }
        return 0;
      case "c": {
        const letter = this.peek();
        if (!ASCII_LETTER.test(letter)) throw new RegexSyntaxError("invalid \\c escape", start);
        this.pos += 1;
        return letter.charCodeAt(0) % 32;
      }
      case "x":
        return this.parseHexDigits(2, start, "invalid \\x escape");
      case "u":
        return this.parseHexDigits(4, start, "invalid \\u escape");
      default:
        if (IDENTITY_ESCAPES.includes(escaped)) return escaped.charCodeAt(0);
        throw new RegexSyntaxError(`unsupported escape '\\${escaped}'`, start);
    }
  }

  /** Reads exactly `count` hexadecimal digits at the current position, or throws `what` at `start`. */
  private parseHexDigits(count: number, start: number, what: string): number {
    const digits = this.src.slice(this.pos, this.pos + count);
    if (digits.length !== count || !HEX_DIGITS.test(digits)) {
      throw new RegexSyntaxError(what, start);
    }
    this.pos += count;
    return Number.parseInt(digits, 16);
  }
}

/** Adds the ranges of one class item to `ranges`. */
function pushAtom(ranges: CodeRange[], atom: ClassAtom): void {
  if (atom.kind === "code") {
    ranges.push([atom.code, atom.code]);
    return;
  }
  for (const range of atom.ranges) ranges.push([range[0], range[1]]);
}
