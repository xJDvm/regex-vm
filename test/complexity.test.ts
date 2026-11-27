import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RegexSyntaxError } from "../src/errors.js";
import { print } from "../src/print.js";
import { compile, type Regex } from "../src/regex.js";
import { run, type RunStats } from "../src/vm.js";
import { astArb, propertyOptions } from "./arbitraries.js";

/** Code units of the generated inputs: the generator alphabet, so that patterns and inputs meet often. */
const INPUT_ALPHABET = [..."abc \n"];

/** Longest generated input for the step-bound property. */
const MAX_INPUT_LENGTH = 40;

/** Length of the inputs of the fixed ReDoS cases. */
const REDOS_LENGTH = 10_000;

/** One search for the step-bound property: an input and a start offset within it, as {@link run} requires. */
interface Probe {
  readonly input: string;
  readonly start: number;
}

const probeArb: fc.Arbitrary<Probe> = fc
  .array(fc.constantFrom(...INPUT_ALPHABET), { maxLength: MAX_INPUT_LENGTH })
  .map((chars) => chars.join(""))
  .chain((input) =>
    fc.nat({ max: input.length }).map((start): Probe => ({ input, start })),
  );

/**
 * Runs `regex` on `input` from `start` and asserts invariant 2 of the design: the VM enters at most `(n + 1) · m`
 * program counters, where `n` is the input length and `m` the number of instructions.
 *
 * @returns The step count, so that callers can check that the counter was actually driven.
 */
function expectStepBound(regex: Regex, input: string, start: number): number {
  const stats: RunStats = { steps: 0 };
  run(regex.program, input, start, stats);
  const bound = (input.length + 1) * regex.program.insts.length;
  expect(stats.steps).toBeLessThanOrEqual(bound);
  return stats.steps;
}

describe("invariant 2: linear step bound", () => {
  it("holds for generated patterns on generated inputs", () => {
    fc.assert(
      fc.property(astArb, probeArb, (ast, { input, start }) => {
        expectStepBound(compile(print(ast)), input, start);
      }),
      propertyOptions(),
    );
  });

  const redosCases: readonly { readonly pattern: string; readonly input: string; readonly index: number | null }[] = [
    { pattern: "(a+)+b", input: "a".repeat(REDOS_LENGTH), index: null },
    { pattern: "(a|a)*b", input: "a".repeat(REDOS_LENGTH), index: null },
    { pattern: "(a*)*b", input: "a".repeat(REDOS_LENGTH), index: null },
    { pattern: "(\\w+\\s?)*$", input: "a".repeat(REDOS_LENGTH - 1) + "!", index: REDOS_LENGTH },
  ];

  for (const { pattern, input, index } of redosCases) {
    it(`bounds the steps of ${pattern} on a ${REDOS_LENGTH}-character input`, () => {
      const regex = compile(pattern);
      const steps = expectStepBound(regex, input, 0);
      expect(steps).toBeGreaterThan(0);
      expect(regex.exec(input)?.index ?? null).toBe(index);
    });
  }
});

/** Longest arbitrary pattern or input, in code units. */
const ARBITRARY_LENGTH = 40;

/** Arbitrary pattern text: any UTF-16 code units, lone surrogates included. */
const arbitraryPatternArb = fc.string({ unit: "binary", maxLength: ARBITRARY_LENGTH });
/** Arbitrary subject text: any UTF-16 code units, lone surrogates included. */
const arbitraryInputArb = fc.string({ unit: "binary", maxLength: ARBITRARY_LENGTH });
/** Start offsets inside, beyond and below the input, plus the non-integer values `exec` must tolerate. */
const arbitraryStartArb = fc.oneof(
  fc.integer({ min: -2, max: ARBITRARY_LENGTH + 2 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5),
);

describe("invariant 1: exec never throws", () => {
  it("accepts any start offset on a compiled generated pattern", () => {
    fc.assert(
      fc.property(astArb, arbitraryInputArb, arbitraryStartArb, (ast, input, start) => {
        expect(() => compile(print(ast)).exec(input, start)).not.toThrow();
      }),
      propertyOptions(),
    );
  });

  it("throws only RegexSyntaxError from compile, and never from exec, for arbitrary patterns", () => {
    fc.assert(
      fc.property(arbitraryPatternArb, arbitraryInputArb, arbitraryStartArb, (pattern, input, start) => {
        let regex: Regex;
        try {
          regex = compile(pattern);
        } catch (error) {
          expect(error).toBeInstanceOf(RegexSyntaxError);
          return;
        }
        expect(() => regex.exec(input, start)).not.toThrow();
      }),
      propertyOptions(),
    );
  });
});
