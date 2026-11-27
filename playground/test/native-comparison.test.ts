import { describe, expect, it } from "vitest";
import type { NativeOutcome } from "../src/analyze.ts";
import { startNativeComparison } from "../src/native-comparison.ts";
import type { NativeRequest } from "../src/native.ts";

/** A stand-in for a worker: it records its traffic and answers only when the test says so. */
class FakeWorker {
  onmessage: ((event: MessageEvent<NativeOutcome>) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly requests: NativeRequest[] = [];
  terminated = false;

  postMessage(request: NativeRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: NativeOutcome): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  fail(message: string): void {
    this.onerror?.({ message });
  }
}

/** Starts a comparison of `a+` on `aa` in the given fake worker. */
function start(worker: FakeWorker, timeoutMs = 1000) {
  return startNativeComparison("a+", "aa", { timeoutMs, createWorker: () => worker });
}

/** Waits for `ms` milliseconds of real time. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startNativeComparison", () => {
  it("posts the pattern and input, then resolves with the reply and terminates the worker", async () => {
    const worker = new FakeWorker();
    const comparison = start(worker);
    expect(worker.requests).toEqual([{ pattern: "a+", input: "aa" }]);

    const reply: NativeOutcome = { kind: "none" };
    worker.reply(reply);

    await expect(comparison.outcome).resolves.toEqual(reply);
    expect(worker.terminated).toBe(true);
  });

  it("resolves with a timeout and terminates the worker when no reply arrives in time", async () => {
    const worker = new FakeWorker();
    const comparison = start(worker, 5);

    await expect(comparison.outcome).resolves.toEqual({ kind: "timeout" });
    expect(worker.terminated).toBe(true);
  });

  it("rejects when the worker fails, and terminates it", async () => {
    const worker = new FakeWorker();
    const comparison = start(worker);

    worker.fail("boom");

    await expect(comparison.outcome).rejects.toThrow("boom");
    expect(worker.terminated).toBe(true);
  });

  it("names the failure when the worker reports no message", async () => {
    const worker = new FakeWorker();
    const comparison = start(worker);

    worker.fail("");

    await expect(comparison.outcome).rejects.toThrow("the native worker failed");
  });

  it("cancel terminates the worker and leaves the outcome pending past the timeout", async () => {
    const worker = new FakeWorker();
    const comparison = start(worker, 5);
    let settled = false;
    void comparison.outcome.finally(() => {
      settled = true;
    });

    comparison.cancel();
    await pause(30);

    expect(worker.terminated).toBe(true);
    expect(settled).toBe(false);
  });
});
