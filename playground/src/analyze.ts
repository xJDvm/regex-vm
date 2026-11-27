import { compile, disassemble, type Match, type Regex, RegexSyntaxError } from "../../src/index.ts";

/** Longest test string the playground accepts, in UTF-16 code units. */
export const MAX_INPUT_LENGTH = 200;

/** The parts of a match that regex-vm and the native `RegExp` both report. */
export interface MatchSummary {
  /** Offset of the first code unit of the match. */
  index: number;
  /** Offset just past the last code unit of the match. */
  end: number;
  /** Text of each capture; `groups[0]` is the whole match. */
  groups: (string | undefined)[];
}

/** Outcome of a run by regex-vm. */
export type LibraryOutcome = { kind: "match"; match: MatchSummary } | { kind: "none" };

/** Outcome of a run by the native `RegExp`, which is skipped for patterns that backtrack exponentially. */
export type NativeOutcome = LibraryOutcome | { kind: "skipped" };

/** One row of the capture table. */
export interface CaptureRow {
  /** Group number, followed by the group name when it has one. */
  label: string;
  /** `[start, end)` offsets, or `undefined` when the group did not participate. */
  span: [number, number] | undefined;
  /** Captured text, or `undefined` when the group did not participate. */
  text: string | undefined;
}

/** Whether the two engines agree, or `unchecked` when the native engine was skipped. */
export type Verdict = "agree" | "differ" | "unchecked";

/** Everything the playground shows for one pattern and test string. */
export type Analysis =
  | { ok: false; message: string; position: number }
  | {
      ok: true;
      /** One entry per instruction, in program-counter order. */
      bytecode: string[];
      captures: CaptureRow[];
      library: LibraryOutcome;
      native: NativeOutcome;
      verdict: Verdict;
    };

/**
 * Compiles `pattern`, runs it on `input` with regex-vm and, unless `skipNative` is set, with the native `RegExp`, then
 * compares the two results.
 *
 * @param pattern - Pattern text, without slashes or flags.
 * @param input - Test string, at most {@link MAX_INPUT_LENGTH} code units.
 * @param skipNative - Set for patterns on which the native engine would backtrack exponentially.
 * @returns The analysis, or the syntax error that stopped compilation.
 * @throws {RangeError} When `input` is longer than {@link MAX_INPUT_LENGTH}.
 */
export function analyze(pattern: string, input: string, skipNative: boolean): Analysis {
  if (input.length > MAX_INPUT_LENGTH) {
    throw new RangeError(`input is longer than ${MAX_INPUT_LENGTH} code units`);
  }
  let regex: Regex;
  try {
    regex = compile(pattern);
  } catch (error) {
    if (error instanceof RegexSyntaxError) {
      return { ok: false, message: error.message, position: error.position };
    }
    throw error;
  }
  const matched = regex.exec(input);
  const library: LibraryOutcome =
    matched === null ? { kind: "none" } : { kind: "match", match: summarize(matched) };
  const native: NativeOutcome = skipNative ? { kind: "skipped" } : runNative(pattern, input);
  return {
    ok: true,
    bytecode: disassemble(regex.program).split("\n"),
    captures: matched === null ? [] : captureRows(matched, regex),
    library,
    native,
    verdict: verdictOf(library, native),
  };
}

/** Reduces a regex-vm match to the fields shared with the native engine. */
function summarize(match: Match): MatchSummary {
  return { index: match.index, end: match.end, groups: match.groups };
}

/** Runs the native engine and reports its match in the same shape as regex-vm. */
function runNative(pattern: string, input: string): NativeOutcome {
  const matched = new RegExp(pattern).exec(input);
  if (matched === null) return { kind: "none" };
  const whole = matched[0] ?? "";
  return {
    kind: "match",
    match: { index: matched.index, end: matched.index + whole.length, groups: [...matched] },
  };
}

/** Builds the capture table for a regex-vm match, labelling each group with its name when it has one. */
function captureRows(match: Match, regex: Regex): CaptureRow[] {
  const nameOf = new Map<number, string>();
  for (const [name, index] of regex.program.groupNames) nameOf.set(index, name);
  return match.spans.map((span, index) => {
    const name = nameOf.get(index);
    let label = String(index);
    if (index === 0) label = "0 (whole match)";
    else if (name !== undefined) label = `${index} (${name})`;
    return { label, span, text: match.groups[index] };
  });
}

/** Compares the two engines: `agree`, `differ`, or `unchecked` when the native engine did not run. */
function verdictOf(library: LibraryOutcome, native: NativeOutcome): Verdict {
  if (native.kind === "skipped") return "unchecked";
  return sameOutcome(library, native) ? "agree" : "differ";
}

/** Whether two outcomes report the same match, with the same span and the same capture texts. */
function sameOutcome(a: LibraryOutcome, b: LibraryOutcome): boolean {
  if (a.kind === "none" || b.kind === "none") return a.kind === b.kind;
  const left = a.match;
  const right = b.match;
  return (
    left.index === right.index &&
    left.end === right.end &&
    left.groups.length === right.groups.length &&
    left.groups.every((text, group) => text === right.groups[group])
  );
}
