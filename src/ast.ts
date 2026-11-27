import type { Ranges } from "./charclass.js";

/** Source offsets of a node: `start` inclusive, `end` exclusive, in UTF-16 code units. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Matches the empty string (an empty alternative or an empty group body). */
export interface Empty extends Span {
  readonly type: "empty";
}

/** Matches one UTF-16 code unit. */
export interface Char extends Span {
  readonly type: "char";
  readonly code: number;
}

/** The `.` atom: any code unit except line terminators. */
export interface Any extends Span {
  readonly type: "any";
}

/** A bracket expression. With `negated` set, it matches code units outside `ranges`. */
export interface Class extends Span {
  readonly type: "class";
  readonly ranges: Ranges;
  readonly negated: boolean;
}

/** Concatenation of two or more items. */
export interface Seq extends Span {
  readonly type: "seq";
  readonly items: readonly Node[];
}

/** Alternation of two or more alternatives, tried left to right. */
export interface Alt extends Span {
  readonly type: "alt";
  readonly alts: readonly Node[];
}

/**
 * A parenthesized group. Capturing groups have a 1-based `index`; named groups also have a `name`.
 * Non-capturing groups have both set to `null`.
 */
export interface Group extends Span {
  readonly type: "group";
  readonly index: number | null;
  readonly name: string | null;
  readonly body: Node;
}

/** Zero-width assertion kinds. `start`/`end` are input boundaries; the `B` kinds test ASCII word boundaries. */
export type AssertKind = "start" | "end" | "wordB" | "notWordB";

/** A zero-width assertion. */
export interface Assert extends Span {
  readonly type: "assert";
  readonly kind: AssertKind;
}

/**
 * A quantified atom. `max` is `Infinity` for unbounded quantifiers. `greedy` is `false` for lazy quantifiers
 * (a trailing `?`), which prefer fewer repetitions.
 */
export interface Repeat extends Span {
  readonly type: "repeat";
  readonly body: Node;
  readonly min: number;
  readonly max: number;
  readonly greedy: boolean;
}

/** Any node of the pattern syntax tree. */
export type Node = Empty | Char | Any | Class | Seq | Alt | Group | Assert | Repeat;
