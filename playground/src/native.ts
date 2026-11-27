import type { NativeOutcome } from "./analyze.ts";

/** A native run that finished on its own, without the timeout. */
export type FinishedNative = Exclude<NativeOutcome, { kind: "timeout" }>;

/** Message posted to the native worker: the pattern and the test string to run it on. */
export interface NativeRequest {
  readonly pattern: string;
  readonly input: string;
}

/**
 * Runs the native `RegExp` once. Pure and synchronous, so it can run in a worker or directly in a test; the caller
 * decides whether it may block.
 *
 * @param pattern - Pattern text, without slashes or flags.
 * @param input - Test string.
 * @returns The match in regex-vm's shape, `none`, or `rejected` when V8 refuses the pattern.
 */
export function execNative(pattern: string, input: string): FinishedNative {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "rejected", message: error.message };
    throw error;
  }
  const matched = regex.exec(input);
  if (matched === null) return { kind: "none" };
  const whole = matched[0] ?? "";
  return {
    kind: "match",
    match: { index: matched.index, end: matched.index + whole.length, groups: [...matched] },
  };
}
