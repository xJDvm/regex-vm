import { describe, expect, it } from "vitest";
import { compileAst } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { run, type RunStats } from "../src/vm.js";

/** Compiles `pattern` and runs it on `input` from `start`, returning the slots as a plain array or `null`. */
function slotsOf(pattern: string, input: string, start = 0, stats?: RunStats): number[] | null {
  const slots = run(compileAst(parse(pattern)), input, start, stats);
  return slots === null ? null : [...slots];
}

describe("run: greedy and lazy quantifiers", () => {
  it("prefers the longest match for a greedy quantifier", () => {
    expect(slotsOf("a+", "aaa")).toEqual([0, 3]);
  });

  it("prefers the shortest match for a lazy quantifier", () => {
    expect(slotsOf("a+?", "aaa")).toEqual([0, 1]);
  });

  it("applies laziness to counted repetitions", () => {
    expect(slotsOf("a{1,3}", "aaaa")).toEqual([0, 3]);
    expect(slotsOf("a{1,3}?", "aaaa")).toEqual([0, 1]);
    expect(slotsOf("a{2,}?", "aaaa")).toEqual([0, 2]);
  });

  it("matches the empty string for a star over nothing in the input", () => {
    expect(slotsOf("b*", "aaa")).toEqual([0, 0]);
  });
});

describe("run: alternation priority", () => {
  it("chooses the first alternative that matches, even when a later one is longer", () => {
    expect(slotsOf("a|ab", "ab")).toEqual([0, 1]);
  });

  it("chooses the longer alternative when it comes first", () => {
    expect(slotsOf("ab|a", "ab")).toEqual([0, 2]);
  });

  it("cuts lower-priority threads once a higher-priority one matches", () => {
    expect(slotsOf("a|ab", "abc")).toEqual([0, 1]);
  });
});

describe("run: search", () => {
  it("returns the leftmost match", () => {
    expect(slotsOf("b", "abcb")).toEqual([1, 2]);
    expect(slotsOf("c|a", "ba")).toEqual([1, 2]);
  });

  it("returns null when nothing matches", () => {
    expect(slotsOf("x", "abc")).toBeNull();
    expect(slotsOf("a", "")).toBeNull();
    expect(slotsOf("ab", "a")).toBeNull();
  });

  it("matches the empty pattern at the start offset", () => {
    expect(slotsOf("", "ab")).toEqual([0, 0]);
    expect(slotsOf("", "ab", 1)).toEqual([1, 1]);
    expect(slotsOf("", "ab", 2)).toEqual([2, 2]);
  });

  it("starts the search at the given offset", () => {
    expect(slotsOf("a", "aXa", 1)).toEqual([2, 3]);
    expect(slotsOf("a", "aXa", 3)).toBeNull();
  });

  it("returns null when the start offset is past the end of the input", () => {
    expect(slotsOf("", "ab", 3)).toBeNull();
  });
});

describe("run: assertions", () => {
  it("anchors ^ to the start of the input, not to the start offset", () => {
    expect(slotsOf("^a", "ba")).toBeNull();
    expect(slotsOf("^a", "ab", 1)).toBeNull();
    expect(slotsOf("^a", "ab")).toEqual([0, 1]);
  });

  it("anchors $ to the end of the input", () => {
    expect(slotsOf("a$", "aa")).toEqual([1, 2]);
    expect(slotsOf("$", "ab")).toEqual([2, 2]);
    expect(slotsOf("a$", "ab")).toBeNull();
  });

  it("matches \\b between a word and a non-word character", () => {
    expect(slotsOf("\\bb", "ab b")).toEqual([3, 4]);
    expect(slotsOf("b\\b", "bc b")).toEqual([3, 4]);
  });

  it("matches \\B where \\b does not", () => {
    expect(slotsOf("\\Bb", "ab")).toEqual([1, 2]);
    expect(slotsOf("\\B", "")).toEqual([0, 0]);
    expect(slotsOf("\\b", "")).toBeNull();
  });

  it("looks at the code unit before the start offset when testing \\b", () => {
    expect(slotsOf("\\bb", "ab", 1)).toBeNull();
    expect(slotsOf("\\bb", "a b", 1)).toEqual([2, 3]);
  });
});

describe("run: captures", () => {
  it("records the span of each group and leaves non-participating groups unset", () => {
    expect(slotsOf("(a)(b)?", "a")).toEqual([0, 1, 0, 1, -1, -1]);
  });

  it("resets captures at the start of each loop iteration", () => {
    expect(slotsOf("(?:(a)|b)+", "ab")).toEqual([0, 2, -1, -1]);
  });

  it("keeps the captures of the highest-priority path", () => {
    expect(slotsOf("(a|ab)(c|bcd)(d*)", "abcd")).toEqual([0, 4, 0, 1, 1, 4, 4, 4]);
  });
});

describe("run: step bound", () => {
  it("enters at most one program counter per position and instruction", () => {
    const program = compileAst(parse("(a+)+b"));
    const input = "a".repeat(200);
    const stats: RunStats = { steps: 0 };
    expect(run(program, input, 0, stats)).toBeNull();
    expect(stats.steps).toBeGreaterThan(0);
    expect(stats.steps).toBeLessThanOrEqual((input.length + 1) * program.insts.length);
  });

  it("stays within the bound for a match found late in the input", () => {
    const program = compileAst(parse("(a|aa)*c"));
    const input = `${"a".repeat(500)}c`;
    const stats: RunStats = { steps: 0 };
    expect(run(program, input, 0, stats)).not.toBeNull();
    expect(stats.steps).toBeLessThanOrEqual((input.length + 1) * program.insts.length);
  });
});

describe("run: optional iterations of nullable bodies must consume input", () => {
  it("does not count an empty optional iteration, so the alternative that consumes wins", () => {
    expect(slotsOf("(?:|a)?", "a")).toEqual([0, 1]);
    expect(slotsOf("(?:|a)?b", "ab")).toEqual([0, 2]);
  });

  it("applies the rule to every optional copy of a counted repetition", () => {
    expect(slotsOf("(?:|a){0,2}", "aa")).toEqual([0, 2]);
    expect(slotsOf("x(?:|a){0,3}$", "xaa")).toEqual([0, 3]);
  });

  it("keeps laziness for optional copies whose body can match empty", () => {
    expect(slotsOf("(?:|a){0,2}?", "aa")).toEqual([0, 0]);
  });

  it("allows empty mandatory copies", () => {
    expect(slotsOf("(?:|a){2}", "a")).toEqual([0, 0]);
  });

  it("keeps the captures of the consuming optional iteration", () => {
    expect(slotsOf("(a|){0,2}", "aa")).toEqual([0, 2, 1, 2]);
  });

  // Known divergence, kept visible: the VM drops the consuming iteration that V8 takes.
  it.fails("matches the iteration of a nullable loop that consumes input", () => {
    expect(slotsOf("(?:.*?)*", "aa")).toEqual([0, 2]);
  });
});
