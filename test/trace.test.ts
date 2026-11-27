import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileAst } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { print } from "../src/print.js";
import type { Program } from "../src/program.js";
import { compile } from "../src/regex.js";
import { type Step, trace } from "../src/trace.js";
import { run } from "../src/vm.js";
import { astArb, propertyOptions } from "./arbitraries.js";

/** Code units of the generated inputs: the generator alphabet, so that patterns and inputs meet often. */
const INPUT_ALPHABET = [..."abc \n"];

/** Compiles `pattern` into a program. */
function programOf(pattern: string): Program {
  return compileAst(parse(pattern));
}

/** Collects every step of the trace of `pattern` on `input`. */
function stepsOf(pattern: string, input: string, maxSteps?: number): Step[] {
  return [...trace(programOf(pattern), input, maxSteps)];
}

/** The last step that is not the truncation marker, which carries the final state of the search. */
function lastRealStep(steps: readonly Step[]): Step | undefined {
  return steps.filter((step) => step.truncated !== true).at(-1);
}

describe("trace: final state", () => {
  const cases: readonly { readonly pattern: string; readonly input: string }[] = [
    { pattern: "a+", input: "aaa" },
    { pattern: "a+?", input: "aaa" },
    { pattern: "a|ab", input: "abc" },
    { pattern: "ab|a", input: "xab" },
    { pattern: "(a|b)*c", input: "ababc" },
    { pattern: "(a+)+b", input: "aaaa" },
    { pattern: "^a", input: "ba" },
    { pattern: "\\bb", input: "a b" },
    { pattern: "(a)(x)?", input: "ab" },
    { pattern: "(?<n>b)", input: "abc" },
    { pattern: "", input: "" },
    { pattern: "x", input: "abc" },
  ];

  for (const { pattern, input } of cases) {
    it(`ends with the slots of run for ${JSON.stringify(pattern)} on ${JSON.stringify(input)}`, () => {
      const program = programOf(pattern);
      const expected = run(program, input, 0);
      const final = lastRealStep(stepsOf(pattern, input));
      expect(final?.matched ?? null).toEqual(expected === null ? null : [...expected].slice(0, program.slotCount));
    });
  }

  it("ends with the index and end that exec reports", () => {
    const regex = compile("(b+)c");
    const final = lastRealStep([...trace(regex.program, "abbc")]);
    expect(final?.matched?.slice(0, 2)).toEqual([1, 4]);
    expect(regex.exec("abbc")).toMatchObject({ index: 1, end: 4 });
  });

  it("reports null as the final match when nothing matches", () => {
    const steps = stepsOf("x", "abc");
    expect(steps.every((step) => step.matched === null)).toBe(true);
  });
});

describe("trace: steps", () => {
  it("yields one step per input position, starting at 0", () => {
    const steps = stepsOf("x", "abc");
    expect(steps.map((step) => step.pos)).toEqual([0, 1, 2, 3]);
  });

  it("yields a single step for the empty input", () => {
    expect(stepsOf("a", "").map((step) => step.pos)).toEqual([0]);
  });

  it("lists the threads that wait at the instructions of the position", () => {
    const [first] = stepsOf("a", "ab");
    expect(first?.threads.map((thread) => thread.pc)).toEqual([1]);
    expect(first?.threads[0]?.slots).toEqual([0, -1]);
  });

  it("lists the threads in priority order", () => {
    const [first] = stepsOf("a|b", "c");
    expect(first?.threads.map((thread) => thread.pc)).toEqual([2, 4]);
  });

  it("shows a match only from the position where it is reached", () => {
    const steps = stepsOf("bc", "abc");
    expect(steps.map((step) => step.matched)).toEqual([null, null, null, [1, 3]]);
  });

  it("reports capture slots without the registers that follow them", () => {
    const program = programOf("(a*)*b");
    for (const step of trace(program, "aab")) {
      for (const thread of step.threads) expect(thread.slots).toHaveLength(program.slotCount);
    }
  });

});

describe("trace: truncation", () => {
  it("is false when the search finishes within maxSteps", () => {
    const steps = stepsOf("b", "aaaa", 5);
    expect(steps.some((step) => step.truncated === true)).toBe(false);
    expect(steps).toHaveLength(5);
  });

  it("is true when the search needs more steps than maxSteps", () => {
    const steps = stepsOf("b", "aaaa", 3);
    expect(steps).toHaveLength(4);
    expect(steps.at(-1)).toMatchObject({ pos: 3, threads: [], truncated: true });
    expect(steps.slice(0, -1).some((step) => step.truncated === true)).toBe(false);
  });

  it("stops after the marker without yielding more positions", () => {
    const steps = stepsOf("b", "a".repeat(50), 10);
    expect(steps).toHaveLength(11);
    expect(steps.at(-1)?.truncated).toBe(true);
  });

  it("yields only the truncation marker when maxSteps is 0 and the search has work", () => {
    expect(stepsOf("a", "a", 0)).toEqual([{ pos: 0, threads: [], matched: null, truncated: true }]);
  });

  it("does not truncate a search that ends exactly at maxSteps", () => {
    const steps = stepsOf("a", "a", 2);
    expect(steps.map((step) => step.pos)).toEqual([0, 1]);
    expect(steps.every((step) => step.truncated !== true)).toBe(true);
  });

  it("keeps the match of the last real step on the truncation marker", () => {
    const steps = stepsOf("a+", "aaaa", 2);
    expect(steps.at(-1)).toMatchObject({ pos: 2, truncated: true, matched: [0, 1] });
  });

  it("does not mark truncation when a match ends the search before maxSteps", () => {
    const steps = stepsOf("a", "aaaa", 2);
    expect(steps.map((step) => step.pos)).toEqual([0, 1]);
    expect(steps.at(-1)?.matched).toEqual([0, 1]);
  });

  it("uses 2000 steps when maxSteps is omitted", () => {
    const pattern = "b";
    const within = stepsOf(pattern, "a".repeat(1999));
    expect(within.some((step) => step.truncated === true)).toBe(false);
    expect(within).toHaveLength(2000);

    const beyond = stepsOf(pattern, "a".repeat(2000));
    expect(beyond).toHaveLength(2001);
    expect(beyond.at(-1)).toMatchObject({ pos: 2000, truncated: true });
  });

  it("rejects a maxSteps that is not a non-negative integer", () => {
    const program = programOf("a");
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => [...trace(program, "a", bad)]).toThrow(RangeError);
    }
  });
});

describe("trace: properties", () => {
  const inputArb = fc.array(fc.constantFrom(...INPUT_ALPHABET), { maxLength: 30 }).map((chars) => chars.join(""));

  it("ends with the slots of run for generated patterns", () => {
    fc.assert(
      fc.property(astArb, inputArb, (ast, input) => {
        const pattern = print(ast);
        const program = programOf(pattern);
        const expected = run(program, input, 0);
        const final = lastRealStep([...trace(program, input)]);
        expect(final?.matched ?? null).toEqual(expected === null ? null : [...expected].slice(0, program.slotCount));
      }),
      propertyOptions(),
    );
  });

  it("yields at most maxSteps steps with threads, and marks truncation exactly when work remains", () => {
    fc.assert(
      fc.property(astArb, inputArb, fc.nat({ max: 35 }), (ast, input, maxSteps) => {
        const program = programOf(print(ast));
        const full = [...trace(program, input)];
        const limited = [...trace(program, input, maxSteps)];
        if (full.length <= maxSteps) {
          expect(limited).toEqual(full);
        } else {
          expect(limited).toHaveLength(maxSteps + 1);
          expect(limited.at(-1)?.truncated).toBe(true);
          expect(limited.slice(0, maxSteps)).toEqual(full.slice(0, maxSteps));
        }
      }),
      propertyOptions(),
    );
  });
});
