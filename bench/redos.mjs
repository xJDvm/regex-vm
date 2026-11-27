// ReDoS benchmark: native RegExp against regex-vm on (a+)+b with "a".repeat(n).
// Run with `npm run bench`, which builds dist/ first.
import { performance } from "node:perf_hooks";
import os from "node:os";
import process from "node:process";
import { compile } from "../dist/index.js";

const PATTERN = "(a+)+b";
// Backtracking time doubles with every extra "a", so the native engine stops at n = 24.
const NATIVE_SIZES = [16, 18, 20, 22, 24];
const VM_SIZES = [24, 1000, 10000, 100000];
const REPETITIONS = 5;

const native = new RegExp(PATTERN);
const vm = compile(PATTERN);

/**
 * Times `run` REPETITIONS times and returns the durations in milliseconds, sorted ascending.
 * Every run must find no match, which is the worst case for both engines.
 */
function measure(run) {
  const durations = [];
  for (let i = 0; i < REPETITIONS; i++) {
    const start = performance.now();
    const result = run();
    durations.push(performance.now() - start);
    if (result !== null) {
      throw new Error(`expected no match for ${PATTERN}`);
    }
  }
  return durations.sort((a, b) => a - b);
}

/** Builds one Markdown table row from the sorted durations of a single cell. */
function row(engine, n, durations) {
  const median = durations[Math.floor(durations.length / 2)];
  return `| ${engine} | ${n} | ${median.toFixed(3)} | ${durations[0].toFixed(3)} |`;
}

const rows = [];
for (const n of NATIVE_SIZES) {
  const input = "a".repeat(n);
  rows.push(row("native RegExp", n, measure(() => native.exec(input))));
}
for (const n of VM_SIZES) {
  const input = "a".repeat(n);
  rows.push(row("regex-vm", n, measure(() => vm.exec(input))));
}

const cpu = os.cpus();
const lines = [
  `Pattern: \`${PATTERN}\`, input: \`"a".repeat(n)\`, no match (worst case).`,
  "",
  `Node.js: ${process.version}`,
  `CPU: ${cpu[0]?.model.trim() ?? "unknown"}, ${cpu.length} logical cores`,
  `Platform: ${os.platform()} ${os.arch()}`,
  `Repetitions per cell: ${REPETITIONS} (median and minimum reported, in milliseconds)`,
  "",
  "| Engine | n | median (ms) | min (ms) |",
  "|---|---|---|---|",
  ...rows,
];
process.stdout.write(`${lines.join("\n")}\n`);
