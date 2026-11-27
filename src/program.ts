import type { Ranges } from "./charclass.js";

/**
 * One instruction of the Pike VM bytecode. Jump targets (`x`, `y`) are program counters. `split` gives priority to
 * `x`: the thread that continues at `x` is ahead of the one at `y`.
 */
export type Inst =
  | { readonly op: "char"; readonly code: number }
  | { readonly op: "class"; readonly index: number }
  | { readonly op: "any" }
  | { readonly op: "split"; readonly x: number; readonly y: number }
  | { readonly op: "jmp"; readonly x: number }
  | { readonly op: "save"; readonly slot: number }
  | { readonly op: "clearCaps"; readonly lo: number; readonly hi: number }
  | { readonly op: "mark"; readonly reg: number }
  | { readonly op: "progress"; readonly reg: number }
  | { readonly op: "assertStart" }
  | { readonly op: "assertEnd" }
  | { readonly op: "wordB" }
  | { readonly op: "notWordB" }
  | { readonly op: "match" };

/** A compiled pattern: the instruction sequence and the tables its instructions refer to. */
export interface Program {
  /** Instructions indexed by program counter. Execution starts at 0. */
  readonly insts: readonly Inst[];
  /** Normalized code-unit ranges of every `class` instruction, indexed by `Inst.index`. Negation is applied. */
  readonly classes: readonly Ranges[];
  /** Number of capture slots: two per group, the whole match included (slots 0 and 1). */
  readonly slotCount: number;
  /**
   * Number of registers used by `mark` and `progress`. A register holds an input position in a thread's slot table,
   * right after the capture slots; `run` does not report them.
   */
  readonly registerCount: number;
  /** Maps each group name to its 1-based capture index. */
  readonly groupNames: ReadonlyMap<string, number>;
}

/**
 * Renders a code unit as a quoted, single-line literal. Printable ASCII other than the quote and the backslash is
 * shown as is; everything else as a `\uXXXX` escape.
 */
function charText(code: number): string {
  const plain = code >= 0x20 && code < 0x7f && code !== 0x27 && code !== 0x5c;
  const text = plain ? String.fromCharCode(code) : `\\u${code.toString(16).padStart(4, "0")}`;
  return `'${text}'`;
}

/** Renders a range list as `[0x30-0x39, 0x41-0x5a]`. */
function rangesText(ranges: Ranges): string {
  const items = ranges.map(([lo, hi]) => `0x${lo.toString(16)}-0x${hi.toString(16)}`);
  return `[${items.join(", ")}]`;
}

/** Returns the mnemonic and operands of one instruction. */
function describe(inst: Inst, program: Program): string {
  switch (inst.op) {
    case "char":
      return `char ${charText(inst.code)}`;
    case "class":
      return `class ${inst.index} ${rangesText(program.classes[inst.index] ?? [])}`;
    case "split":
      return `split ${inst.x}, ${inst.y}`;
    case "jmp":
      return `jmp ${inst.x}`;
    case "save":
      return `save ${inst.slot}`;
    case "clearCaps":
      return `clearCaps ${inst.lo}..${inst.hi}`;
    case "mark":
      return `mark r${inst.reg}`;
    case "progress":
      return `progress r${inst.reg}`;
    case "any":
    case "assertStart":
    case "assertEnd":
    case "wordB":
    case "notWordB":
    case "match":
      return inst.op;
  }
}

/**
 * Renders a program as text, one instruction per line, prefixed by its program counter.
 *
 * @param program - The program to render.
 * @returns Lines such as `003  split 4, 7`, joined by newlines and without a trailing newline.
 */
export function disassemble(program: Program): string {
  return program.insts
    .map((inst, pc) => `${String(pc).padStart(3, "0")}  ${describe(inst, program)}`)
    .join("\n");
}
