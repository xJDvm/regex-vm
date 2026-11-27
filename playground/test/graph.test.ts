import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compile, type Program, RegexSyntaxError } from "../../src/index.ts";
import { GRAPH_COLUMNS, type GraphLayout, layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "../src/graph.ts";

/** Compiles a pattern that is known to be valid. */
function programOf(pattern: string): Program {
  return compile(pattern).program;
}

/** Counts the instructions of a program with the given opcode. */
function countOps(program: Program, op: Program["insts"][number]["op"]): number {
  return program.insts.filter((inst) => inst.op === op).length;
}

/** Every coordinate of a layout, for finiteness and bounds checks. */
function allCoordinates(layout: GraphLayout): number[] {
  const values: number[] = [layout.width, layout.height];
  for (const node of layout.nodes) values.push(node.x, node.y);
  for (const edge of layout.edges) {
    values.push(edge.start.x, edge.start.y, edge.control.x, edge.control.y, edge.end.x, edge.end.y);
  }
  return values;
}

describe("layoutGraph: nodes", () => {
  it("has one node per program counter, in order", () => {
    for (const pattern of ["", "a", "a|b", "(a+)+b", "a{2,5}?", "(?<n>x)(y)|z*"]) {
      const program = programOf(pattern);
      const layout = layoutGraph(program);
      expect(layout.nodes.map((node) => node.pc), pattern).toEqual(
        program.insts.map((_, pc) => pc),
      );
      layout.nodes.forEach((node, pc) => expect(node.op, pattern).toBe(program.insts[pc]?.op));
    }
  });

  it("wraps rows after GRAPH_COLUMNS boxes and keeps each box inside the drawing", () => {
    const layout = layoutGraph(programOf("abcdefghijklmnopqrstuvwxyz"));
    const second = layout.nodes[GRAPH_COLUMNS];
    const first = layout.nodes[0];
    expect(second?.y).toBeGreaterThan(first?.y ?? Infinity);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it("lays out the empty pattern as the whole-match saves and the match instruction, with no arc", () => {
    const layout = layoutGraph(programOf(""));
    expect(layout.nodes.map((node) => node.op)).toEqual(["save", "save", "match"]);
    expect(layout.edges).toEqual([]);
  });
});

describe("layoutGraph: arcs", () => {
  it("draws no arc for a program without branches", () => {
    expect(layoutGraph(programOf("abc")).edges).toEqual([]);
    expect(layoutGraph(programOf("[a-z]{3}")).edges).toEqual([]);
  });

  it("draws both arcs of the split and the jump that closes the first alternative", () => {
    // split, char a, jmp end, char b, match
    const layout = layoutGraph(programOf("a|b"));
    expect(layout.edges.map((edge) => edge.kind)).toEqual(["priority", "alternative", "jump"]);
  });

  it("draws three arcs for a star: a split with two targets and the loop jump", () => {
    // split 1, 3; char a; jmp 0; match
    const program = programOf("a*");
    const layout = layoutGraph(program);
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.filter((edge) => edge.kind === "jump")).toHaveLength(1);
    expect(layout.edges.filter((edge) => edge.kind === "priority")).toHaveLength(1);
    expect(layout.edges.filter((edge) => edge.kind === "alternative")).toHaveLength(1);
  });

  it("gives the priority arc to the greedy body and to the lazy exit", () => {
    for (const [pattern, priorityOp] of [
      ["a*", "char"],
      ["a*?", "save"],
    ] as const) {
      const program = programOf(pattern);
      const layout = layoutGraph(program);
      const split = program.insts.find((inst) => inst.op === "split");
      const priority = layout.edges.find((edge) => edge.kind === "priority");
      const alternative = layout.edges.find((edge) => edge.kind === "alternative");
      expect(split?.op, pattern).toBe("split");
      expect(priority?.to, pattern).toBe(split?.op === "split" ? split.x : undefined);
      expect(alternative?.to, pattern).toBe(split?.op === "split" ? split.y : undefined);
      expect(program.insts[priority?.to ?? -1]?.op, pattern).toBe(priorityOp);
    }
  });

  it("matches the arc counts of the program: two per split, one per jmp", () => {
    for (const pattern of ["a?b??c", "(a|b|c)+", "(a+)+b", "x{2,4}|y{1,}"]) {
      const program = programOf(pattern);
      const expected = 2 * countOps(program, "split") + countOps(program, "jmp");
      expect(layoutGraph(program).edges, pattern).toHaveLength(expected);
    }
  });

  it("bends forward arcs above their endpoints and backward arcs below them", () => {
    const layout = layoutGraph(programOf("a*"));
    const loop = layout.edges.find((edge) => edge.kind === "jump");
    expect(loop?.to).toBeLessThan(loop?.from ?? 0);
    if (loop === undefined) throw new Error("expected a loop arc");
    expect(loop.control.y).toBeGreaterThan(Math.max(loop.start.y, loop.end.y));

    const forward = layout.edges.find((edge) => edge.kind === "priority");
    if (forward === undefined) throw new Error("expected a forward arc");
    expect(forward.control.y).toBeLessThan(Math.min(forward.start.y, forward.end.y));
  });

  it("starts and ends arcs on the boxes they connect", () => {
    const layout = layoutGraph(programOf("(a|bc)*d"));
    for (const edge of layout.edges) {
      const source = layout.nodes[edge.from];
      const target = layout.nodes[edge.to];
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(edge.start.x).toBeGreaterThanOrEqual(source?.x ?? Infinity);
      expect(edge.start.x).toBeLessThanOrEqual((source?.x ?? 0) + NODE_WIDTH);
      expect(edge.end.x).toBeGreaterThanOrEqual(target?.x ?? Infinity);
      expect(edge.end.x).toBeLessThanOrEqual((target?.x ?? 0) + NODE_WIDTH);
    }
  });

  it("rejects a branch whose target is not a program counter", () => {
    const program: Program = {
      insts: [{ op: "jmp", x: 5 }, { op: "match" }],
      classes: [],
      slotCount: 2,
      registerCount: 0,
      groupNames: new Map(),
    };
    expect(() => layoutGraph(program)).toThrow(RangeError);
  });
});

describe("layoutGraph: coordinates", () => {
  it("has no NaN or infinite coordinate for the presets", () => {
    for (const pattern of ["[a-z0-9._%+-]+@[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z]{2,}", "(a+)+b", "cat|category", "<.+?>"]) {
      for (const value of allCoordinates(layoutGraph(programOf(pattern)))) {
        expect(Number.isFinite(value), pattern).toBe(true);
      }
    }
  });

  it("has no NaN or infinite coordinate for any valid generated pattern", () => {
    const atoms = ["a", "b", "(", ")", "|", "*", "+", "?", "??", "{1,3}", "[ab]", ".", "^", "$", "\\b", "(?:", "*?"];
    const patterns = fc.array(fc.constantFrom(...atoms), { maxLength: 14 }).map((parts) => parts.join(""));
    fc.assert(
      fc.property(patterns, (pattern) => {
        let program: Program;
        try {
          program = programOf(pattern);
        } catch (error) {
          expect(error).toBeInstanceOf(RegexSyntaxError);
          return;
        }
        const layout = layoutGraph(program);
        expect(layout.nodes).toHaveLength(program.insts.length);
        expect(layout.edges).toHaveLength(2 * countOps(program, "split") + countOps(program, "jmp"));
        for (const value of allCoordinates(layout)) expect(Number.isFinite(value)).toBe(true);
        for (const node of layout.nodes) {
          expect(node.x).toBeGreaterThanOrEqual(0);
          expect(node.y).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
