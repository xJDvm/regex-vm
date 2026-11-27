import { compileAst } from "./compiler.js";
import { RegexSyntaxError } from "./errors.js";
import { parse } from "./parser.js";
import type { Program } from "./program.js";
import { run } from "./vm.js";

/** A successful match, shaped like the result of `RegExp.prototype.exec`. */
export interface Match {
  /** Offset of the first code unit of the match. */
  index: number;
  /** Offset just past the last code unit of the match. */
  end: number;
  /** Text of each capture; `groups[0]` is the whole match. A group that did not participate is `undefined`. */
  groups: (string | undefined)[];
  /** Text of each named group, keyed by name. Every named group is present; unmatched ones are `undefined`. */
  named: Record<string, string | undefined>;
  /** `[start, end]` offsets of each capture, parallel to `groups`; `undefined` when the group did not participate. */
  spans: ([number, number] | undefined)[];
}

/**
 * A compiled regular expression. Obtain one with {@link compile}.
 *
 * Matching enters at most (n + 1)·m program counters, where n is the input length and m the program size. Each step
 * also copies the capture and register slots it writes, so the worst case is O((n + 1)·m·k), with k the number of
 * slots and registers.
 */
export class Regex {
  /** The pattern text this expression was compiled from. */
  readonly source: string;
  /** The bytecode that {@link exec} and {@link test} run. */
  readonly program: Program;

  /**
   * @param source - The pattern text.
   * @param program - The program compiled from `source`.
   */
  constructor(source: string, program: Program) {
    this.source = source;
    this.program = program;
  }

  /**
   * Finds the leftmost match of the pattern in `input` at or after `start`, preferring the alternatives and quantifier
   * choices that a backtracking engine would prefer.
   *
   * `start` is handled like `lastIndex` in `RegExp.prototype.exec`: fractions are truncated, values below zero and
   * `NaN` count as zero, and a value past the end of the input finds nothing.
   *
   * @param input - The string to search.
   * @param start - Offset where the search begins.
   * @returns The match, or `null` when there is none.
   */
  exec(input: string, start = 0): Match | null {
    const slots = this.search(input, start);
    return slots === null ? null : toMatch(slots, input, this.program);
  }

  /**
   * Tests whether the pattern matches `input` at or after `start`. Accepts the same `start` values as {@link exec}.
   *
   * @param input - The string to search.
   * @param start - Offset where the search begins.
   * @returns `true` when there is a match.
   */
  test(input: string, start = 0): boolean {
    return this.search(input, start) !== null;
  }

  /** Runs the program from a normalized start offset, returning the capture slots of the match or `null`. */
  private search(input: string, start: number): Int32Array | null {
    const from = Number.isNaN(start) ? 0 : Math.max(0, Math.trunc(start));
    if (from > input.length) return null;
    return run(this.program, input, from);
  }
}

/**
 * Converts capture slots into a {@link Match}.
 *
 * @param slots - The slots produced by the VM for a successful match.
 * @param input - The string that was searched.
 * @param program - The program that produced the slots; supplies the group count and names.
 */
function toMatch(slots: Int32Array, input: string, program: Program): Match {
  const groupCount = program.slotCount / 2;
  const spans: ([number, number] | undefined)[] = [];
  const groups: (string | undefined)[] = [];
  for (let group = 0; group < groupCount; group++) {
    const start = slots[2 * group] ?? -1;
    const end = slots[2 * group + 1] ?? -1;
    if (start < 0 || end < 0) {
      spans.push(undefined);
      groups.push(undefined);
    } else {
      spans.push([start, end]);
      groups.push(input.slice(start, end));
    }
  }
  // A null prototype keeps a group named `__proto__` an ordinary key.
  const named = Object.create(null) as Record<string, string | undefined>;
  for (const [name, index] of program.groupNames) named[name] = groups[index];
  return {
    index: slots[0] ?? 0,
    end: slots[1] ?? 0,
    groups,
    named,
    spans,
  };
}

/**
 * Compiles a pattern for matching.
 *
 * The pattern is read with the non-Unicode JavaScript grammar. Constructs outside the supported subset, such as
 * backreferences, lookaround and Annex-B leniencies, are rejected rather than approximated.
 *
 * @param pattern - The pattern text, at most 10 000 code units.
 * @param flags - Regular-expression flags. Only the empty string is supported for now.
 * @returns The compiled expression.
 * @throws {RegexSyntaxError} When the pattern or the flags are not supported, or the pattern exceeds a limit.
 */
export function compile(pattern: string, flags: "" = ""): Regex {
  if (flags !== "") throw new RegexSyntaxError("unsupported flags", 0);
  return new Regex(pattern, compileAst(parse(pattern)));
}
