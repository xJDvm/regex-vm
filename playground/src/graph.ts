import type { Program } from "../../src/index.ts";

/** Instructions per row of the graph. Rows wrap, so a long program stays legible at any width. */
export const GRAPH_COLUMNS = 6;
/** Width of an instruction box, in SVG user units. */
export const NODE_WIDTH = 120;
/** Height of an instruction box, in SVG user units. */
export const NODE_HEIGHT = 40;
/** Horizontal space between two boxes of one row. */
const GAP_X = 36;
/** Vertical room kept above and below each row for the arcs that leave or enter it. */
const BAND = 64;
/** Outer margin of the drawing. */
const MARGIN = 16;
/** Height of the shortest arc, the one between two neighbouring instructions. */
const LIFT_BASE = 12;
/** Extra arc height per instruction of distance between the two ends of an arc. */
const LIFT_STEP = 6;
/** Distance beyond which an arc stops growing taller, which keeps it inside its band. */
const MAX_SPAN = 8;

/** A point in SVG user units. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Opcode name of an instruction. */
export type Opcode = Program["insts"][number]["op"];

/** One instruction box. `x` and `y` are the coordinates of its top-left corner. */
export interface GraphNode {
  /** Program counter of the instruction. */
  readonly pc: number;
  /** Opcode of the instruction. */
  readonly op: Opcode;
  readonly x: number;
  readonly y: number;
}

/**
 * Role of an arc. `priority` is the `x` target of a `split`, which the thread takes first; `alternative` is the `y`
 * target of a `split`; `jump` is the target of a `jmp`.
 */
export type EdgeKind = "priority" | "alternative" | "jump";

/** A quadratic Bézier arc from `start` to `end`, bent towards `control`. */
export interface GraphEdge {
  /** Program counter of the branching instruction. */
  readonly from: number;
  /** Program counter the arc leads to. */
  readonly to: number;
  readonly kind: EdgeKind;
  readonly start: Point;
  readonly control: Point;
  readonly end: Point;
}

/** A positioned NFA graph of a program, in SVG user units. */
export interface GraphLayout {
  /** Width of the drawing. */
  readonly width: number;
  /** Height of the drawing. */
  readonly height: number;
  /** One box per instruction, in program-counter order. */
  readonly nodes: readonly GraphNode[];
  /** One arc per branch target of every `split` and `jmp`. */
  readonly edges: readonly GraphEdge[];
}

/**
 * Lays out the NFA graph of a program: one box per instruction in program-counter order, wrapped into rows of
 * {@link GRAPH_COLUMNS}, and one arc per branch target of each `split` and `jmp`. Sequential flow is not drawn.
 *
 * A forward arc leaves the top of its source box and enters the top of its target. A backward arc, which closes a
 * loop, uses the bottom edges. Each arc bends away from its row, so it never runs through the box it leaves.
 *
 * @param program - A program produced by the compiler.
 * @returns The layout. Every coordinate is finite and lies inside the drawing.
 * @throws {RangeError} When a branch target is not a program counter of `program`.
 */
export function layoutGraph(program: Program): GraphLayout {
  const count = program.insts.length;
  const columns = Math.max(1, Math.min(GRAPH_COLUMNS, count));
  const rows = Math.ceil(count / GRAPH_COLUMNS);
  const nodes: GraphNode[] = program.insts.map((inst, pc) => ({
    pc,
    op: inst.op,
    x: MARGIN + (pc % GRAPH_COLUMNS) * (NODE_WIDTH + GAP_X),
    y: MARGIN + BAND + Math.floor(pc / GRAPH_COLUMNS) * (NODE_HEIGHT + 2 * BAND),
  }));
  const edges: GraphEdge[] = [];
  program.insts.forEach((inst, pc) => {
    if (inst.op === "split") {
      edges.push(arc(nodes, pc, inst.x, "priority"), arc(nodes, pc, inst.y, "alternative"));
    } else if (inst.op === "jmp") {
      edges.push(arc(nodes, pc, inst.x, "jump"));
    }
  });
  return {
    width: 2 * MARGIN + columns * NODE_WIDTH + (columns - 1) * GAP_X,
    height: 2 * MARGIN + rows * (NODE_HEIGHT + 2 * BAND),
    nodes,
    edges,
  };
}

/**
 * Computes the arc from the instruction at `from` to the one at `to`.
 *
 * @throws {RangeError} When `to` is not a program counter of `nodes`.
 */
function arc(nodes: readonly GraphNode[], from: number, to: number, kind: EdgeKind): GraphEdge {
  const source = nodes[from];
  const target = nodes[to];
  if (source === undefined || target === undefined) {
    throw new RangeError(`branch from ${from} to ${to} leaves the program`);
  }
  const forward = to > from;
  const lift = LIFT_BASE + LIFT_STEP * Math.min(Math.abs(to - from), MAX_SPAN);
  const startY = forward ? source.y : source.y + NODE_HEIGHT;
  const endY = forward ? target.y : target.y + NODE_HEIGHT;
  const bend = forward ? Math.min(startY, endY) - 2 * lift : Math.max(startY, endY) + 2 * lift;
  const start = { x: source.x + NODE_WIDTH / 2, y: startY };
  const end = { x: target.x + NODE_WIDTH / 2, y: endY };
  return { from, to, kind, start, control: { x: (start.x + end.x) / 2, y: bend }, end };
}
