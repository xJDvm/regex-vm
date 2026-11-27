import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { execNative } from "../src/native.ts";

describe("execNative", () => {
  it("reports the match with its span and captures, leaving groups that did not take part unset", () => {
    expect(execNative("(a)|b", "b")).toEqual({
      kind: "match",
      match: { index: 0, end: 1, groups: ["b", undefined] },
    });
  });

  it("reports no match when the pattern does not occur", () => {
    expect(execNative("x", "abc")).toEqual({ kind: "none" });
  });

  it("reports a pattern that V8 rejects, with the engine's message", () => {
    const result = execNative("(", "a");
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("expected a rejection");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("rejects a class range that is out of order", () => {
    expect(execNative("[b-a]", "a").kind).toBe("rejected");
  });

  it("rejects exactly the patterns that the RegExp constructor rejects, and never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (pattern) => {
        let constructs = true;
        try {
          new RegExp(pattern);
        } catch {
          constructs = false;
        }
        expect(execNative(pattern, "ab%").kind === "rejected").toBe(!constructs);
      }),
      { numRuns: 500 },
    );
  });
});
