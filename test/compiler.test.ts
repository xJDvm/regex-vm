import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileAst } from "../src/compiler.js";
import { RegexSyntaxError } from "../src/errors.js";
import { parse } from "../src/parser.js";
import { disassemble, type Program } from "../src/program.js";
import { print } from "../src/print.js";
import { astArb, propertyOptions } from "./arbitraries.js";

/** Parses and compiles `pattern`, then renders the bytecode. */
function listing(pattern: string): string {
  return disassemble(compileAst(parse(pattern)));
}

/** Parses and compiles `pattern`. */
function compile(pattern: string): Program {
  return compileAst(parse(pattern));
}

/** Runs `action`, which must throw, and returns the error it threw. */
function errorOf(action: () => unknown): RegexSyntaxError {
  try {
    action();
  } catch (error) {
    if (error instanceof RegexSyntaxError) return error;
    throw error;
  }
  throw new Error("expected the action to throw");
}

/** Largest program the compiler may emit, as stated in the design. */
const LIMIT = 50_000;

/**
 * Checks the structural invariants every compiled program must satisfy: it is bracketed by `save 0` and
 * `save 1; match`, every jump target is an instruction, and every slot, class and capture range is in bounds.
 */
function expectWellFormed(program: Program): void {
  const { insts, classes, slotCount, registerCount } = program;
  expect(insts.length).toBeLessThanOrEqual(LIMIT);
  expect(insts[0]).toEqual({ op: "save", slot: 0 });
  expect(insts.slice(-2)).toEqual([{ op: "save", slot: 1 }, { op: "match" }]);
  const inRange = (pc: number): boolean => Number.isInteger(pc) && pc >= 0 && pc < insts.length;
  for (const inst of insts) {
    switch (inst.op) {
      case "split":
        expect(inRange(inst.x) && inRange(inst.y)).toBe(true);
        break;
      case "jmp":
        expect(inRange(inst.x)).toBe(true);
        break;
      case "save":
        expect(inst.slot).toBeLessThan(slotCount);
        break;
      case "clearCaps":
        expect(inst.lo).toBeGreaterThanOrEqual(2);
        expect(inst.lo).toBeLessThanOrEqual(inst.hi);
        expect(inst.hi).toBeLessThan(slotCount);
        break;
      case "mark":
      case "progress":
        expect(inst.reg).toBeLessThan(registerCount);
        break;
      case "class":
        expect(inst.index).toBeLessThan(classes.length);
        break;
      default:
        break;
    }
  }
}

describe("compileAst: bytecode listings", () => {
  it("compiles a literal to one instruction per code unit", () => {
    expect(listing("abc")).toMatchInlineSnapshot(`
      "000  save 0
      001  char 'a'
      002  char 'b'
      003  char 'c'
      004  save 1
      005  match"
    `);
  });

  it("compiles a bracket expression to a class table entry, negated by complement", () => {
    expect(listing("[^a-c]")).toMatchInlineSnapshot(`
      "000  save 0
      001  class 0 [0x0-0x60, 0x64-0xffff]
      002  save 1
      003  match"
    `);
  });

  it("compiles alternation with a split and a jump to the end per alternative", () => {
    expect(listing("a|bc|d")).toMatchInlineSnapshot(`
      "000  save 0
      001  split 2, 4
      002  char 'a'
      003  jmp 9
      004  split 5, 8
      005  char 'b'
      006  char 'c'
      007  jmp 9
      008  char 'd'
      009  save 1
      010  match"
    `);
  });

  it("compiles a greedy star so that the body has priority", () => {
    expect(listing("a*")).toMatchInlineSnapshot(`
      "000  save 0
      001  split 2, 4
      002  char 'a'
      003  jmp 1
      004  save 1
      005  match"
    `);
  });

  it("compiles a lazy star so that the exit has priority", () => {
    expect(listing("a*?b")).toMatchInlineSnapshot(`
      "000  save 0
      001  split 4, 2
      002  char 'a'
      003  jmp 1
      004  char 'b'
      005  save 1
      006  match"
    `);
  });

  it("expands a bounded greedy repetition into mandatory and optional copies", () => {
    expect(listing("x{2,3}")).toMatchInlineSnapshot(`
      "000  save 0
      001  char 'x'
      002  char 'x'
      003  split 4, 5
      004  char 'x'
      005  save 1
      006  match"
    `);
  });

  it("expands a bounded lazy repetition with every optional exit pointing past the copies", () => {
    expect(listing("(a){0,2}?")).toMatchInlineSnapshot(`
      "000  save 0
      001  split 11, 2
      002  clearCaps 2..3
      003  save 2
      004  char 'a'
      005  save 3
      006  split 11, 7
      007  clearCaps 2..3
      008  save 2
      009  char 'a'
      010  save 3
      011  save 1
      012  match"
    `);
  });

  it("wraps capturing groups in save instructions and leaves non-capturing groups bare", () => {
    expect(listing("(a)(?:b)")).toMatchInlineSnapshot(`
      "000  save 0
      001  save 2
      002  char 'a'
      003  save 3
      004  char 'b'
      005  save 1
      006  match"
    `);
  });

  it("clears the captures of a named group at the start of every iteration", () => {
    expect(listing("(?<n>a)+")).toMatchInlineSnapshot(`
      "000  save 0
      001  clearCaps 2..3
      002  save 2
      003  char 'a'
      004  save 3
      005  split 6, 11
      006  clearCaps 2..3
      007  save 2
      008  char 'a'
      009  save 3
      010  jmp 5
      011  save 1
      012  match"
    `);
  });

  it("compiles the assertions to their own instructions", () => {
    expect(listing("^\\b\\B$")).toMatchInlineSnapshot(`
      "000  save 0
      001  assertStart
      002  wordB
      003  notWordB
      004  assertEnd
      005  save 1
      006  match"
    `);
  });

  it("emits nothing for a repetition of zero copies and for the empty pattern", () => {
    expect(listing("a{0}")).toMatchInlineSnapshot(`
      "000  save 0
      001  save 1
      002  match"
    `);
    expect(listing("")).toBe(listing("a{0}"));
  });

  it("guards an optional copy of a nullable body with a mark and a progress check", () => {
    expect(listing("(?:|a)?")).toMatchInlineSnapshot(`
      "000  save 0
      001  split 2, 7
      002  mark r0
      003  split 4, 5
      004  jmp 6
      005  char 'a'
      006  progress r0
      007  save 1
      008  match"
    `);
  });

  it("leaves mandatory copies and unguarded optional copies unchanged", () => {
    expect(compile("(?:|a){2}").registerCount).toBe(0);
    expect(compile("(?:a|){0,2}").registerCount).toBe(1);
    expect(compile("a{0,2}").registerCount).toBe(0);
    expect(compile("(?:|a)*").registerCount).toBe(0);
  });

  it("sizes each guarded optional copy as the body, its split, and the mark and progress pair", () => {
    // The alternation `|a` is three instructions (split, jmp, char), and each copy adds a split, a mark and a
    // progress: 3 + 3 = 6 per copy, plus the 3 wrapper instructions.
    expect(compile("(?:|a){0,1000}").insts.length).toBe(6 * 1000 + 3);
  });

  it("sizes the slot table from the number of groups, the whole match included", () => {
    expect(compile("(a)(b(c))").slotCount).toBe(8);
    expect(compile("abc").slotCount).toBe(2);
  });

  it("shares the group name table with the parser", () => {
    expect(compile("(?<x>a)(?<y>b)").groupNames).toEqual(
      new Map([
        ["x", 1],
        ["y", 2],
      ]),
    );
  });
});

describe("compileAst: program size limit", () => {
  // `(?:a{1000}){49}` emits 49 000 instructions, and each `a{k}` adds k.
  const prefix = "(?:a{1000}){49}";

  it("accepts a program of exactly 50 000 instructions", () => {
    const program = compile(`${prefix}a{997}`);
    expect(program.insts.length).toBe(LIMIT);
    expectWellFormed(program);
  });

  it("rejects a program of 50 001 instructions with a positioned error", () => {
    const error = errorOf(() => compile(`${prefix}a{998}`));
    expect(error.message).toBe("pattern too large at position 0");
    expect(error.position).toBe(0);
  });

  it("counts the capture instructions of each iteration against the limit at N and N+1", () => {
    // Each `(a)` iteration emits clearCaps, save, char and save (4 instructions), and each outer iteration adds one
    // more clearCaps: 12 · (1 + 1 000 · 4) = 48 012. With the 3 wrapper instructions and `a{1000}a{985}`, the total
    // is 48 012 + 1 985 + 3 = 50 000.
    expect(compile("(?:(a){1000}){12}a{1000}a{985}").insts.length).toBe(LIMIT);
    expect(errorOf(() => compile("(?:(a){1000}){12}a{1000}a{986}")).message).toBe(
      "pattern too large at position 0",
    );
  });

  it("rejects a deeply nested expansion without expanding it", () => {
    let nested = "a";
    for (let depth = 0; depth < 4; depth++) nested = `(?:${nested}){1000}`;
    expect(() => compile(nested)).toThrow(RegexSyntaxError);
  });

  it("accepts a nested repetition whose body is empty, whatever its counts", () => {
    expect(compile("(?:(?:){1000}){1000}").insts.length).toBe(3);
  });
});

describe("compileAst: properties", () => {
  it("emits well-formed programs for generated syntax trees", () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        expectWellFormed(compile(print(ast)));
      }),
      propertyOptions(),
    );
  });

  it("emits well-formed programs or rejects the pattern with a RegexSyntaxError", () => {
    const alphabet = "ab()[]|*+?{},0123-^$\\.:<>=!nb";
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 60 }).map((c) => c.join("")), (pattern) => {
        let program: Program | undefined;
        try {
          program = compile(pattern);
        } catch (error) {
          expect(error).toBeInstanceOf(RegexSyntaxError);
          return;
        }
        expectWellFormed(program);
      }),
      propertyOptions(),
    );
  });
});
