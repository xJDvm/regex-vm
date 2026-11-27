import type { AssertKind, Node, Repeat } from "./ast.js";
import { type CodeRange, negate } from "./charclass.js";
import { RegexSyntaxError } from "./errors.js";
import type { ParseResult } from "./parser.js";
import type { Inst, Program } from "./program.js";

/** Largest number of instructions a compiled program may have. */
const MAX_PROGRAM_SIZE = 50_000;

/** Instructions around the body: `save 0` before it, `save 1` and `match` after it. */
const WRAPPER_SIZE = 3;

/** Sizes are capped at this value, so that intermediate results never overflow and stay cheap to add. */
const SIZE_CAP = MAX_PROGRAM_SIZE + 1;

/**
 * Returns the capture slots written by the groups inside `node`, as an inclusive range.
 *
 * Group indices are assigned in source order, so the groups of a subtree are contiguous and their slots form one
 * range.
 *
 * @param node - The subtree to inspect.
 * @returns `[lo, hi]` slot bounds, or `null` when the subtree has no capturing group.
 */
function captureSlots(node: Node): readonly [number, number] | null {
  switch (node.type) {
    case "group": {
      const inner = captureSlots(node.body);
      if (node.index === null) return inner;
      const own: readonly [number, number] = [2 * node.index, 2 * node.index + 1];
      if (inner === null) return own;
      return [Math.min(own[0], inner[0]), Math.max(own[1], inner[1])];
    }
    case "seq":
      return unionSlots(node.items);
    case "alt":
      return unionSlots(node.alts);
    case "repeat":
      return captureSlots(node.body);
    default:
      return null;
  }
}

/** Slot bounds covering every node in `nodes`, or `null` when none of them captures. */
function unionSlots(nodes: readonly Node[]): readonly [number, number] | null {
  let result: readonly [number, number] | null = null;
  for (const node of nodes) {
    const slots = captureSlots(node);
    if (slots === null) continue;
    result = result === null ? slots : [Math.min(result[0], slots[0]), Math.max(result[1], slots[1])];
  }
  return result;
}

/**
 * Whether `node` can match the empty string. Assertions match empty, and a repetition with a zero minimum does too.
 *
 * @param node - The subtree to inspect.
 * @returns `true` when some way of matching `node` consumes no input.
 */
function canMatchEmpty(node: Node): boolean {
  switch (node.type) {
    case "empty":
    case "assert":
      return true;
    case "char":
    case "any":
    case "class":
      return false;
    case "seq":
      return node.items.every(canMatchEmpty);
    case "alt":
      return node.alts.some(canMatchEmpty);
    case "group":
      return canMatchEmpty(node.body);
    case "repeat":
      return node.min === 0 || canMatchEmpty(node.body);
  }
}

/**
 * Computes the exact number of instructions {@link compileAst} emits for `node`, capped at {@link SIZE_CAP}.
 *
 * Counted repetitions are sized from their bounds, so nothing is expanded to find out how large a program would
 * be. The arithmetic is exact below the cap, and the cap keeps every intermediate value finite.
 *
 * @param node - The subtree to measure.
 * @returns The instruction count, or {@link SIZE_CAP} when it is at least that large.
 */
function measure(node: Node): number {
  switch (node.type) {
    case "empty":
      return 0;
    case "seq":
      return capped(node.items.reduce((sum, item) => sum + measure(item), 0));
    case "alt": {
      // Every alternative but the last is preceded by a split and followed by a jump to the end.
      const bodies = node.alts.reduce((sum, alt) => sum + measure(alt), 0);
      return capped(bodies + 2 * (node.alts.length - 1));
    }
    case "group":
      return capped(measure(node.body) + (node.index === null ? 0 : 2));
    case "repeat":
      return measureRepeat(node);
    default:
      return 1;
  }
}

/**
 * Size of a repetition: `min` mandatory copies, then either a loop or `max - min` optional copies. An optional copy
 * whose body can match empty also carries the `mark` and `progress` pair.
 */
function measureRepeat(node: Repeat): number {
  const copy = measure(node.body) + (captureSlots(node.body) === null ? 0 : 1);
  const mandatory = node.min * copy;
  if (node.max === Infinity) return capped(mandatory + copy + 2);
  const guard = canMatchEmpty(node.body) ? 2 : 0;
  return capped(mandatory + (node.max - node.min) * (copy + guard + 1));
}

/** Clamps a size to {@link SIZE_CAP}. */
function capped(size: number): number {
  return Math.min(size, SIZE_CAP);
}

/**
 * Emits the instructions of a syntax tree. Each method appends to `insts`, and jump targets that are not yet known
 * are filled in once the code they point to has been emitted.
 */
class Emitter {
  readonly insts: Inst[] = [];
  readonly classes: CodeRange[][] = [];
  /** Number of registers allocated so far; each repetition that needs one takes the next. */
  registerCount = 0;

  /** Emits the instructions of `node`, leaving control at the next instruction. */
  compile(node: Node): void {
    switch (node.type) {
      case "empty":
        return;
      case "char":
        this.insts.push({ op: "char", code: node.code });
        return;
      case "any":
        this.insts.push({ op: "any" });
        return;
      case "class":
        this.classes.push(node.negated ? negate(node.ranges) : [...node.ranges]);
        this.insts.push({ op: "class", index: this.classes.length - 1 });
        return;
      case "assert":
        this.insts.push({ op: assertOp(node.kind) });
        return;
      case "seq":
        for (const item of node.items) this.compile(item);
        return;
      case "alt":
        this.compileAlt(node.alts);
        return;
      case "group":
        this.compileGroup(node.index, node.body);
        return;
      case "repeat":
        this.compileRepeat(node);
        return;
    }
  }

  /** Emits `alt0 | alt1 | …`: a split before each alternative but the last, a jump to the end after each. */
  private compileAlt(alts: readonly Node[]): void {
    const jumps: number[] = [];
    alts.forEach((alt, i) => {
      if (i === alts.length - 1) {
        this.compile(alt);
        return;
      }
      const split = this.hole();
      this.compile(alt);
      jumps.push(this.hole());
      this.fill(split, { op: "split", x: split + 1, y: this.insts.length });
    });
    for (const jump of jumps) this.fill(jump, { op: "jmp", x: this.insts.length });
  }

  /** Emits a capturing group between its two `save` instructions, or a non-capturing group as its body. */
  private compileGroup(index: number | null, body: Node): void {
    if (index === null) {
      this.compile(body);
      return;
    }
    this.insts.push({ op: "save", slot: 2 * index });
    this.compile(body);
    this.insts.push({ op: "save", slot: 2 * index + 1 });
  }

  /**
   * Emits a quantifier. Every copy of the body starts by clearing the captures of the groups inside it, as JavaScript
   * does on each iteration.
   *
   * An optional copy (one beyond `min`) whose body can match empty must consume input to count, as in ECMAScript's
   * RepeatMatcher. Such a copy records its start position in a register and fails when it ends where it started.
   * Unbounded loops rely on their head, which is already visited at the start position, to drop an empty iteration.
   * That covers the cases the differential test reaches only partly; see the known divergence in `test/vm.test.ts`.
   */
  private compileRepeat(node: Repeat): void {
    const slots = captureSlots(node.body);
    const iteration = (): void => {
      if (slots !== null) this.insts.push({ op: "clearCaps", lo: slots[0], hi: slots[1] });
      this.compile(node.body);
    };
    for (let i = 0; i < node.min; i++) iteration();
    if (node.max === Infinity) {
      this.compileLoop(node.greedy, iteration);
      return;
    }
    const register = node.max > node.min && canMatchEmpty(node.body) ? this.registerCount++ : null;
    const exits: number[] = [];
    for (let i = node.min; i < node.max; i++) {
      exits.push(this.hole());
      if (register === null) {
        iteration();
      } else {
        this.insts.push({ op: "mark", reg: register });
        iteration();
        this.insts.push({ op: "progress", reg: register });
      }
    }
    const end = this.insts.length;
    for (const pc of exits) this.fill(pc, this.choice(node.greedy, pc + 1, end));
  }

  /** Emits `body*`: a split that enters the body or leaves the loop, and a jump back to the split. */
  private compileLoop(greedy: boolean, iteration: () => void): void {
    const head = this.hole();
    iteration();
    this.insts.push({ op: "jmp", x: head });
    this.fill(head, this.choice(greedy, head + 1, this.insts.length));
  }

  /** A split that tries the body at `body` and the exit at `exit`, in the order chosen by `greedy`. */
  private choice(greedy: boolean, body: number, exit: number): Inst {
    return greedy ? { op: "split", x: body, y: exit } : { op: "split", x: exit, y: body };
  }

  /** Reserves an instruction slot whose contents are filled in later with {@link fill}. */
  private hole(): number {
    this.insts.push({ op: "jmp", x: -1 });
    return this.insts.length - 1;
  }

  /** Replaces the instruction at `pc`, which must have been reserved with {@link hole}. */
  private fill(pc: number, inst: Inst): void {
    this.insts[pc] = inst;
  }
}

/** Maps an assertion kind to the instruction that tests it. */
function assertOp(kind: AssertKind): "assertStart" | "assertEnd" | "wordB" | "notWordB" {
  switch (kind) {
    case "start":
      return "assertStart";
    case "end":
      return "assertEnd";
    case "wordB":
      return "wordB";
    case "notWordB":
      return "notWordB";
  }
}

/**
 * Compiles a parsed pattern to Pike VM bytecode, using Thompson's construction.
 *
 * The program starts with `save 0` and ends with `save 1; match`, so the whole match occupies slots 0 and 1. Groups
 * are wrapped in `save` instructions for their two slots. Greedy quantifiers prefer another iteration, lazy ones
 * prefer to stop. A counted repetition `{n,m}` is expanded into `n` copies of the body followed by `m - n` optional
 * copies; `{n,}` ends in a loop. The size is computed before anything is emitted, so a pattern that would exceed the
 * limit is rejected in time proportional to the pattern, not to the program it would produce.
 *
 * @param parsed - The result of {@link parse}.
 * @returns The compiled program. Its size is at most 50 000 instructions.
 * @throws {RegexSyntaxError} `"pattern too large"` at position 0 when the program would exceed 50 000 instructions.
 */
export function compileAst(parsed: ParseResult): Program {
  if (measure(parsed.ast) + WRAPPER_SIZE > MAX_PROGRAM_SIZE) {
    throw new RegexSyntaxError("pattern too large", 0);
  }
  const emitter = new Emitter();
  emitter.insts.push({ op: "save", slot: 0 });
  emitter.compile(parsed.ast);
  emitter.insts.push({ op: "save", slot: 1 }, { op: "match" });
  return {
    insts: emitter.insts,
    classes: emitter.classes,
    slotCount: 2 * (parsed.groupCount + 1),
    registerCount: emitter.registerCount,
    groupNames: parsed.groupNames,
  };
}
