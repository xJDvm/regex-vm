import { contains, type Ranges, WORD } from "./charclass.js";
import type { Inst, Program } from "./program.js";

/** Counters that {@link run} fills in when it is given an object to write to. */
export interface RunStats {
  /** Number of program counters entered, summed over all input positions. */
  steps: number;
}

/** A thread that waits at a consuming instruction or at `match`, together with its capture slots. */
export interface Thread {
  readonly pc: number;
  readonly slots: Int32Array;
}

/** A pending entry of the explicit stack used by {@link PikeVm.addThread}. */
interface Frame {
  readonly pc: number;
  readonly slots: Int32Array;
}

/** Set of integers in `[0, capacity)` with constant-time insertion, membership and clearing. */
export class SparseSet {
  private readonly dense: Int32Array;
  private readonly sparse: Int32Array;
  private size = 0;

  /** @param capacity - Exclusive upper bound of the members. */
  constructor(capacity: number) {
    this.dense = new Int32Array(capacity);
    this.sparse = new Int32Array(capacity);
  }

  /** Tests whether `value` is a member. */
  has(value: number): boolean {
    const index = this.sparse[value] ?? 0;
    return index < this.size && this.dense[index] === value;
  }

  /** Adds `value`, which must not be a member yet. */
  add(value: number): void {
    this.dense[this.size] = value;
    this.sparse[value] = this.size;
    this.size++;
  }

  /** Removes every member in constant time. */
  clear(): void {
    this.size = 0;
  }
}

/** The pcs visited at one input position, and the threads among them that consume input or match. */
export class ThreadList {
  /** Program counters entered for this input position; each is entered at most once. */
  readonly visited: SparseSet;
  /** Threads in priority order: the first one has the highest priority. */
  readonly threads: Thread[] = [];

  /** @param programSize - Number of instructions of the program. */
  constructor(programSize: number) {
    this.visited = new SparseSet(programSize);
  }

  /** Empties the list so that it can be filled for another input position. */
  clear(): void {
    this.visited.clear();
    this.threads.length = 0;
  }
}

/** Code units that `.` does not match: `\n`, `\r`, `U+2028` and `U+2029`. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/** Tests whether a code unit is an ASCII word character, as `\b` requires. */
function isWordCode(code: number): boolean {
  return contains(WORD, code);
}

/**
 * Runs the Pike VM: a Thompson NFA simulation that keeps one thread per program counter and input position, ordered
 * by priority, so that the first match found is the one a backtracking engine would report.
 */
export class PikeVm {
  private readonly insts: readonly Inst[];
  private readonly classes: readonly Ranges[];
  private readonly slotCount: number;
  private readonly initial: Int32Array;
  private readonly stack: Frame[] = [];

  /**
   * @param program - The program to run.
   * @param input - The subject string.
   * @param stats - Receives the step count when given.
   */
  constructor(
    program: Program,
    private readonly input: string,
    private readonly stats: RunStats | undefined,
  ) {
    this.insts = program.insts;
    this.classes = program.classes;
    this.slotCount = program.slotCount;
    this.initial = new Int32Array(program.slotCount + program.registerCount).fill(-1);
  }

  /**
   * Searches from `start` for the leftmost, highest-priority match.
   *
   * A new thread is seeded at every position until a match is found; it has the lowest priority, so threads that
   * started earlier always win. When a `match` thread is reached, the lower-priority threads at that position are
   * dropped and the search goes on only for the higher-priority ones, which may still produce a longer or preferred
   * match.
   */
  search(start: number): Int32Array | null {
    const n = this.input.length;
    let current = this.newList();
    let next = this.newList();
    let matched: Int32Array | null = null;
    for (let pos = start; pos <= n; pos++) {
      if (matched === null) this.seed(current, pos);
      if (matched !== null && current.threads.length === 0) break;
      matched = this.advance(current, next, pos, matched);
      [current, next] = [next, current];
    }
    return matched;
  }

  /** Creates an empty thread list sized for this program. */
  newList(): ThreadList {
    return new ThreadList(this.insts.length);
  }

  /**
   * Adds the thread that starts the program, at the lowest priority of `list`, for input position `pos`.
   *
   * @param list - The list being filled for input position `pos`.
   * @param pos - Input position where the new thread starts.
   */
  seed(list: ThreadList, pos: number): void {
    this.addThread(list, 0, this.initial, pos);
  }

  /**
   * Moves the threads of `current`, which sit at input position `pos`, past the instructions that consume the code
   * unit at `pos`, filling `next` for position `pos + 1`. `current` is not modified.
   *
   * @param current - The threads at input position `pos`, in priority order.
   * @param next - The list to fill for position `pos + 1`; it is cleared first.
   * @param pos - The input position of `current`.
   * @param matched - The match found so far, or `null`.
   * @returns The slots of the latest match reached, which is `matched` when no thread of `current` matched.
   */
  advance(current: ThreadList, next: ThreadList, pos: number, matched: Int32Array | null): Int32Array | null {
    const code = pos < this.input.length ? this.input.charCodeAt(pos) : -1;
    let found = matched;
    next.clear();
    for (const thread of current.threads) {
      const inst = this.instAt(thread.pc);
      if (inst.op === "match") {
        found = thread.slots;
        break;
      }
      if (this.consumes(inst, code)) this.addThread(next, thread.pc + 1, thread.slots, pos + 1);
    }
    return found;
  }

  /**
   * Adds the thread at `pc0` to `list` and follows every non-consuming instruction it reaches, in priority order.
   * Each program counter is entered at most once per list. The stack is explicit, so the depth of the program does
   * not affect the call stack.
   *
   * @param list - The list being filled for input position `pos`.
   * @param pc0 - Program counter where the thread starts.
   * @param slots0 - Capture slots of the thread. Never modified: writers copy first.
   * @param pos - Input position the thread is at; assertions and captures are evaluated there.
   */
  private addThread(list: ThreadList, pc0: number, slots0: Int32Array, pos: number): void {
    const stack = this.stack;
    stack.length = 0;
    stack.push({ pc: pc0, slots: slots0 });
    let frame: Frame | undefined;
    while ((frame = stack.pop()) !== undefined) {
      const { pc, slots } = frame;
      if (list.visited.has(pc)) continue;
      list.visited.add(pc);
      if (this.stats !== undefined) this.stats.steps++;
      const inst = this.instAt(pc);
      switch (inst.op) {
        case "jmp":
          stack.push({ pc: inst.x, slots });
          break;
        case "split":
          stack.push({ pc: inst.y, slots }, { pc: inst.x, slots });
          break;
        case "save": {
          const copy = slots.slice();
          copy[inst.slot] = pos;
          stack.push({ pc: pc + 1, slots: copy });
          break;
        }
        case "clearCaps": {
          const copy = slots.slice();
          copy.fill(-1, inst.lo, inst.hi + 1);
          stack.push({ pc: pc + 1, slots: copy });
          break;
        }
        case "mark": {
          const copy = slots.slice();
          copy[this.slotCount + inst.reg] = pos;
          stack.push({ pc: pc + 1, slots: copy });
          break;
        }
        case "progress":
          if (slots[this.slotCount + inst.reg] !== pos) stack.push({ pc: pc + 1, slots });
          break;
        case "assertStart":
          if (pos === 0) stack.push({ pc: pc + 1, slots });
          break;
        case "assertEnd":
          if (pos === this.input.length) stack.push({ pc: pc + 1, slots });
          break;
        case "wordB":
          if (this.atWordBoundary(pos)) stack.push({ pc: pc + 1, slots });
          break;
        case "notWordB":
          if (!this.atWordBoundary(pos)) stack.push({ pc: pc + 1, slots });
          break;
        default:
          list.threads.push({ pc, slots });
      }
    }
  }

  /** Tests whether the instruction consumes `code`. `code` is `-1` at the end of the input, which nothing consumes. */
  private consumes(inst: Inst, code: number): boolean {
    switch (inst.op) {
      case "char":
        return code === inst.code;
      case "class": {
        const ranges = this.classes[inst.index];
        return ranges !== undefined && contains(ranges, code);
      }
      case "any":
        return code >= 0 && !isLineTerminator(code);
      default:
        return false;
    }
  }

  /** Tests the `\b` condition at `pos`: the word-ness of the code units on either side differs. */
  private atWordBoundary(pos: number): boolean {
    const before = pos > 0 && isWordCode(this.input.charCodeAt(pos - 1));
    const after = pos < this.input.length && isWordCode(this.input.charCodeAt(pos));
    return before !== after;
  }

  /** Returns the instruction at `pc`, which a compiled program always has. */
  private instAt(pc: number): Inst {
    const inst = this.insts[pc];
    if (inst === undefined) throw new Error(`program counter ${pc} is out of range`);
    return inst;
  }
}

/**
 * Searches `input` for the leftmost, highest-priority match of `program` that starts at or after `start`.
 *
 * Enters at most (n + 1)·m program counters, where n is the input length and m the number of instructions: each
 * program counter is entered at most once per input position. Each entry that writes a capture or register copies the
 * slot array, so a step costs time proportional to the k slots and registers copied, and the worst case is
 * O((n + 1)·m·k).
 *
 * @param program - A program produced by the compiler.
 * @param input - The string to search.
 * @param start - Input position where the search begins, `0 <= start <= input.length`. A larger value yields `null`.
 * @param stats - When given, receives the number of program counters entered.
 * @returns The capture slots of the match, with `-1` for slots that did not participate, or `null` when there is no
 *   match. Slot `2k` and `2k + 1` are the start and end of group `k`; group 0 is the whole match.
 */
export function run(program: Program, input: string, start: number, stats?: RunStats): Int32Array | null {
  const slots = new PikeVm(program, input, stats).search(start);
  return slots === null ? null : slots.slice(0, program.slotCount);
}
