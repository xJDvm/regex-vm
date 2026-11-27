import type { Program } from "./program.js";
import { PikeVm, type ThreadList } from "./vm.js";

/** A thread of a {@link Step}: the instruction it waits at and the capture slots it carries. */
export interface TraceThread {
  /** Program counter of the consuming instruction or `match` the thread waits at. */
  readonly pc: number;
  /** Capture slots of the thread, with `-1` for slots that are unset. Registers are not included. */
  readonly slots: number[];
}

/** The state of the Pike VM at one input position. */
export interface Step {
  /** Input position the threads are at. */
  readonly pos: number;
  /** Threads that consume the code unit at `pos` or wait at `match`, in priority order. */
  readonly threads: TraceThread[];
  /**
   * Capture slots of the latest match reached up to and including `pos`, shaped like the result of {@link run}; `null`
   * while no match has been reached.
   */
  readonly matched: number[] | null;
  /** `true` on the final step when the trace stopped at `maxSteps` before the search was finished. */
  readonly truncated?: true;
}

/**
 * Yields the state of the Pike VM at each input position of a search from position 0, for display. The algorithm is
 * the one of {@link run}: the same thread lists, seeding and priority cuts. The last step that is not truncated
 * carries the same `matched` slots that `run` returns, or `null` when there is no match.
 *
 * At most `maxSteps` steps carry threads. When the search would need more, one final step with empty `threads` and
 * `truncated: true` is yielded and the generator ends.
 *
 * @param program - A program produced by the compiler.
 * @param input - The string to search.
 * @param maxSteps - Number of input positions to yield before stopping. Must be a non-negative integer.
 * @yields One {@link Step} per input position, in increasing order of `pos`.
 * @throws {RangeError} When `maxSteps` is not a non-negative integer.
 */
export function* trace(program: Program, input: string, maxSteps = 2000): Generator<Step> {
  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new RangeError(`maxSteps must be a non-negative integer, got ${maxSteps}`);
  }
  const vm = new PikeVm(program, input, undefined);
  let current: ThreadList = vm.newList();
  let next: ThreadList = vm.newList();
  let matched: Int32Array | null = null;
  let produced = 0;
  for (let pos = 0; pos <= input.length; pos++) {
    if (matched === null) vm.seed(current, pos);
    if (matched !== null && current.threads.length === 0) return;
    if (produced === maxSteps) {
      yield { pos, threads: [], matched: captures(matched, program), truncated: true };
      return;
    }
    const threads = current.threads.map((thread) => ({ pc: thread.pc, slots: captures(thread.slots, program) }));
    matched = vm.advance(current, next, pos, matched);
    [current, next] = [next, current];
    produced++;
    yield { pos, threads, matched: captures(matched, program) };
  }
}

/**
 * Copies the capture slots out of a thread's slot table, leaving out the registers that follow them.
 *
 * @param slots - A slot table of the program, or `null` when there is no match.
 * @param program - The program that owns the slot table.
 * @returns The capture slots as plain numbers, or `null` when `slots` is `null`.
 */
function captures(slots: Int32Array, program: Program): number[];
function captures(slots: Int32Array | null, program: Program): number[] | null;
function captures(slots: Int32Array | null, program: Program): number[] | null {
  return slots === null ? null : Array.from(slots.subarray(0, program.slotCount));
}
