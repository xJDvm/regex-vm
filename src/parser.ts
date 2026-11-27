import type { Node } from "./ast.js";
import { type CodeRange, normalize } from "./charclass.js";
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

/** Characters that may follow a backslash to denote themselves. */
const IDENTITY_ESCAPES = "^$\\.*+?()[]{}|/-";
const GROUP_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const GROUP_NAME_CHAR = /^[A-Za-z0-9_$]$/;

/**
 * Parses a pattern into a syntax tree.
 *
 * Every node records its source span. Quantifiers, escapes other than backslash-escaped syntax
 * characters, backreferences, lookaround, flags and Annex-B leniencies are rejected.
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

  /** `Alternative := Atom*`; an empty alternative yields a node of type `empty`. */
  private parseAlternative(): Node {
    const start = this.pos;
    const items: Node[] = [];
    while (this.pos < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      items.push(this.parseAtom());
    }
    const [first, ...rest] = items;
    if (first === undefined) return { type: "empty", start, end: start };
    if (rest.length === 0) return first;
    return { type: "seq", items, start, end: this.pos };
  }

  private parseAtom(): Node {
    const start = this.pos;
    switch (this.peek()) {
      case "(":
        return this.parseGroup();
      case "[":
        return this.parseClass();
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
      case "{":
        throw new RegexSyntaxError("quantifiers are not supported yet", start);
      case "}":
      case "]":
        throw new RegexSyntaxError(`unmatched '${this.peek()}'`, start);
      default: {
        const code = this.parseCodeUnit();
        return { type: "char", code, start, end: this.pos };
      }
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
      const lo = this.parseCodeUnit();
      const isRange = this.peek() === "-" && this.peek(1) !== "" && this.peek(1) !== "]";
      if (!isRange) {
        ranges.push([lo, lo]);
        continue;
      }
      this.pos += 1;
      const hi = this.parseCodeUnit();
      if (lo > hi) {
        throw new RegexSyntaxError("range out of order in character class", atomStart);
      }
      ranges.push([lo, hi]);
    }
    this.pos += 1;
    return { type: "class", ranges: normalize(ranges), negated, start, end: this.pos };
  }

  /** Consumes one literal code unit, or one identity escape `\X`, and returns its code. */
  private parseCodeUnit(): number {
    const start = this.pos;
    if (this.peek() !== "\\") {
      this.pos += 1;
      return this.src.charCodeAt(start);
    }
    if (this.pos + 1 >= this.src.length) {
      throw new RegexSyntaxError("\\ at end of pattern", start);
    }
    const escaped = this.peek(1);
    if (!IDENTITY_ESCAPES.includes(escaped)) {
      throw new RegexSyntaxError(`unsupported escape '\\${escaped}'`, start);
    }
    this.pos += 2;
    return escaped.charCodeAt(0);
  }
}
