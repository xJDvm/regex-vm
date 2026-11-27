import type { NativeOutcome } from "./analyze.ts";
import type { NativeRequest } from "./native.ts";

/** Milliseconds a native run may take before its worker is terminated. */
export const NATIVE_TIMEOUT_MS = 300;

/** The part of a `Worker` that a comparison uses, so that tests can supply a fake. */
export type WorkerLike = Pick<Worker, "onmessage" | "onerror" | "postMessage" | "terminate">;

/** Options of {@link startNativeComparison}; both default to the production values. */
export interface NativeComparisonOptions {
  /** Milliseconds before the run is abandoned. */
  readonly timeoutMs?: number;
  /** Creates the worker that runs the pattern. */
  readonly createWorker?: () => WorkerLike;
}

/** One native comparison, running in its own worker. */
export interface NativeComparison {
  /**
   * Settles with the native outcome, with `timeout` when the worker did not answer in time, or rejects when the worker
   * fails. After {@link NativeComparison.cancel} it stays pending.
   */
  readonly outcome: Promise<NativeOutcome>;
  /** Terminates the worker and stops the timer, for a comparison whose result is no longer wanted. */
  cancel(): void;
}

/**
 * Creates the worker that runs one native comparison. The module is resolved by the bundler, so the worker ships as
 * its own chunk.
 *
 * @returns A new module worker running `native-worker.ts`.
 */
export function createNativeWorker(): Worker {
  return new Worker(new URL("./native-worker.ts", import.meta.url), { type: "module" });
}

/**
 * Runs the native `RegExp` on `pattern` and `input` in a fresh worker. A worker is created per comparison and is
 * terminated as soon as it answers or the timeout passes, so a catastrophic pattern never blocks the page.
 *
 * @param pattern - Pattern text, without slashes or flags.
 * @param input - Test string.
 * @param options - Timeout and worker factory overrides.
 * @returns The running comparison.
 */
export function startNativeComparison(
  pattern: string,
  input: string,
  options: NativeComparisonOptions = {},
): NativeComparison {
  const timeoutMs = options.timeoutMs ?? NATIVE_TIMEOUT_MS;
  const worker = (options.createWorker ?? createNativeWorker)();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    clearTimeout(timer);
    worker.terminate();
  };
  const outcome = new Promise<NativeOutcome>((resolve, reject) => {
    timer = setTimeout(() => {
      stop();
      resolve({ kind: "timeout" });
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<NativeOutcome>) => {
      stop();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      stop();
      reject(new Error(event.message || "the native worker failed"));
    };
    const request: NativeRequest = { pattern, input };
    worker.postMessage(request);
  });
  return { outcome, cancel: stop };
}
