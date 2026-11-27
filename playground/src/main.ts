import {
  type Analysis,
  analyze,
  type CaptureRow,
  type LibraryOutcome,
  MAX_INPUT_LENGTH,
  type NativeOutcome,
  type Verdict,
} from "./analyze.ts";
import { isCatastrophic, PRESETS, type Preset } from "./presets.ts";
import { drawGraph, highlightGraph } from "./render-graph.ts";
import type { Step, TraceThread } from "../../src/index.ts";

/** Characters of pattern shown on each side of the caret when a syntax error is reported. */
const CARET_CONTEXT = 40;

/** Milliseconds between two steps of playback at speed 1. */
const BASE_INTERVAL_MS = 600;

const VERDICT_TEXT: Record<Verdict, string> = {
  agree: "Agrees with the native RegExp.",
  differ: "Differs from the native RegExp.",
  unchecked: "Not compared: the native RegExp is skipped for this pattern.",
};

/** An analysis of a pattern that compiled, together with the test string it ran on. */
interface Loaded {
  readonly analysis: Extract<Analysis, { ok: true }>;
  readonly input: string;
}

const patternInput = requireElement("pattern", HTMLInputElement);
const testInput = requireElement("test-input", HTMLInputElement);
const presetList = requireElement("presets", HTMLDivElement);
const counter = requireElement("counter", HTMLSpanElement);
const errorBox = requireElement("error", HTMLElement);
const stepButton = requireElement("step", HTMLButtonElement);
const playButton = requireElement("play", HTMLButtonElement);
const speedSelect = requireElement("speed", HTMLSelectElement);
const scrubber = requireElement("scrubber", HTMLInputElement);
const stepPosition = requireElement("step-pos", HTMLSpanElement);
const stepStatus = requireElement("step-status", HTMLParagraphElement);
const truncatedNotice = requireElement("truncated", HTMLParagraphElement);
const tapeBox = requireElement("tape", HTMLDivElement);
const threadCount = requireElement("thread-count", HTMLSpanElement);
const threadList = requireElement("active-thread", HTMLOListElement);
const graphSvg = requireElement("graph", SVGSVGElement);
const bytecodeList = requireElement("bytecode", HTMLOListElement);
const captureBody = requireElement("captures", HTMLTableSectionElement);
const libraryResult = requireElement("match-result", HTMLParagraphElement);
const nativeResult = requireElement("native-result", HTMLParagraphElement);
const verdictLine = requireElement("verdict", HTMLParagraphElement);

/** The analysis on screen, or `undefined` while the pattern has a syntax error. */
let loaded: Loaded | undefined;
/** Index into the steps of `loaded` that is on screen. */
let cursor = 0;
/** Handle of the playback timer, or `undefined` while paused. */
let timer: number | undefined;

for (const preset of PRESETS) presetList.append(presetButton(preset));
patternInput.addEventListener("input", refresh);
testInput.addEventListener("input", refresh);
stepButton.addEventListener("click", stepForward);
playButton.addEventListener("click", togglePlayback);
speedSelect.addEventListener("change", () => {
  if (timer !== undefined) {
    stopPlayback();
    startPlayback();
  }
});
scrubber.addEventListener("input", () => {
  stopPlayback();
  showStep(Number(scrubber.value));
});

const [initial] = PRESETS;
if (initial !== undefined) loadPreset(initial);

/**
 * Looks up an element by id and checks its type.
 *
 * @param id - The element id in `index.html`.
 * @param type - The expected element class.
 * @returns The element.
 * @throws {Error} When the element is missing or has another type.
 */
function requireElement<T extends Element>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is missing or has the wrong type`);
  return element;
}

/**
 * Creates an element whose text is set with `textContent`, so user data is never parsed as HTML.
 *
 * @param tag - The tag name.
 * @param text - The text content.
 * @param className - Optional CSS class.
 * @returns The new element.
 */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/** Creates the button that loads one preset. */
function presetButton(preset: Preset): HTMLButtonElement {
  const button = element("button", preset.name);
  button.type = "button";
  button.addEventListener("click", () => loadPreset(preset));
  return button;
}

/** Fills both inputs from a preset and refreshes the output. */
function loadPreset(preset: Preset): void {
  patternInput.value = preset.pattern;
  testInput.value = preset.input;
  refresh();
}

/** Re-analyses the current inputs and redraws every panel. Playback stops and returns to the first step. */
function refresh(): void {
  const pattern = patternInput.value;
  const input = testInput.value;
  counter.textContent = `${input.length} / ${MAX_INPUT_LENGTH}`;
  stopPlayback();
  render(pattern, input, analyze(pattern, input, isCatastrophic(pattern)));
}

/** Redraws every output panel for one analysis. */
function render(pattern: string, input: string, analysis: Analysis): void {
  if (analysis.ok) {
    errorBox.hidden = true;
    errorBox.replaceChildren();
    loaded = { analysis, input };
    fill(bytecodeList, analysis.bytecode.map(bytecodeRow));
    fill(captureBody, analysis.captures.map(captureLine));
    drawGraph(graphSvg, analysis.graph);
    buildTape(input);
    scrubber.max = String(analysis.steps.length - 1);
    setExecutionEnabled(true);
    libraryResult.textContent = describe(analysis.library);
    nativeResult.textContent = describe(analysis.native);
    verdictLine.textContent = VERDICT_TEXT[analysis.verdict];
    showStep(0);
    return;
  }
  loaded = undefined;
  renderError(pattern, analysis.message, analysis.position);
  fill(bytecodeList, []);
  fill(captureBody, []);
  graphSvg.replaceChildren();
  tapeBox.replaceChildren();
  threadList.replaceChildren();
  stepPosition.textContent = "";
  stepStatus.textContent = "";
  truncatedNotice.hidden = true;
  threadCount.textContent = "";
  scrubber.max = "0";
  setExecutionEnabled(false);
  libraryResult.textContent = "No result: the pattern has a syntax error.";
  nativeResult.textContent = "No result: the pattern has a syntax error.";
  verdictLine.textContent = "";
}

/** Enables or disables the playback controls. */
function setExecutionEnabled(enabled: boolean): void {
  playButton.disabled = !enabled;
  scrubber.disabled = !enabled;
  if (!enabled) stepButton.disabled = true;
}

/**
 * Shows the state of the Pike VM at one step: the active bytecode rows, the graph highlights, the cursor on the input
 * tape, the thread list and the latest match.
 *
 * @param index - Index of the step in the trace. Out-of-range indices are ignored.
 */
function showStep(index: number): void {
  if (loaded === undefined) return;
  const { analysis, input } = loaded;
  const step: Step | undefined = analysis.steps[index];
  if (step === undefined) return;
  cursor = index;
  const active = new Set(step.threads.map((thread) => thread.pc));
  markBytecode(active);
  highlightGraph(graphSvg, active);
  markTapeCursor(step.pos);
  renderThreads(analysis.bytecode, step.threads);
  scrubber.value = String(index);
  stepButton.disabled = index >= analysis.steps.length - 1;
  stepPosition.textContent = `Position ${step.pos} of ${input.length}`;
  stepStatus.textContent = describeMatch(step.matched);
  truncatedNotice.hidden = step.truncated !== true;
}

/** Advances the trace by one step, stopping playback first. */
function stepForward(): void {
  stopPlayback();
  showStep(cursor + 1);
}

/** Starts playback when it is paused, and pauses it when it runs. */
function togglePlayback(): void {
  if (timer === undefined) startPlayback();
  else stopPlayback();
}

/** Starts playback at the chosen speed. Playing from the last step starts again from the first. */
function startPlayback(): void {
  if (loaded === undefined) return;
  if (cursor >= loaded.analysis.steps.length - 1) showStep(0);
  timer = window.setInterval(tick, BASE_INTERVAL_MS / Number(speedSelect.value));
  playButton.textContent = "Pause";
  playButton.setAttribute("aria-pressed", "true");
}

/** Shows the next step, and stops once the last step is on screen. */
function tick(): void {
  if (loaded === undefined) return;
  showStep(cursor + 1);
  if (cursor >= loaded.analysis.steps.length - 1) stopPlayback();
}

/** Pauses playback, if it runs. */
function stopPlayback(): void {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  playButton.textContent = "Play";
  playButton.setAttribute("aria-pressed", "false");
}

/**
 * Replaces the children of `parent` with `nodes`. The nodes are gathered in a fragment first, so a long listing is
 * inserted in one step.
 */
function fill(parent: HTMLElement, nodes: Node[]): void {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) fragment.append(node);
  parent.replaceChildren(fragment);
}

/**
 * Shows a syntax error with a caret under the offending position of the pattern. Long patterns are cut to a window
 * around the caret so the error never widens the page.
 */
function renderError(pattern: string, message: string, position: number): void {
  const at = Math.min(position, pattern.length);
  const start = Math.max(0, at - CARET_CONTEXT);
  const end = Math.min(pattern.length, at + CARET_CONTEXT);
  const lead = start > 0 ? "…" : "";
  const tail = end < pattern.length ? "…" : "";
  const snippet = `${lead}${pattern.slice(start, end)}${tail}`;
  const caret = `${" ".repeat(lead.length + at - start)}^`;
  errorBox.replaceChildren(
    element("h2", "Syntax error"),
    element("p", message, "error-message"),
    element("pre", `${snippet}\n${caret}`, "caret"),
  );
  errorBox.hidden = false;
}

/** Creates one bytecode listing row, e.g. `003  split 4, 7`. */
function bytecodeRow(line: string): HTMLLIElement {
  const row = element("li", line, "bytecode-row");
  row.dataset.testid = "bytecode-row";
  return row;
}

/** Highlights the bytecode rows of the active program counters and clears the other rows. */
function markBytecode(active: ReadonlySet<number>): void {
  for (const row of bytecodeList.querySelectorAll(".active")) row.classList.remove("active");
  for (const pc of active) bytecodeList.children[pc]?.classList.add("active");
}

/** Creates one capture table row. */
function captureLine(capture: CaptureRow): HTMLTableRowElement {
  const row = element("tr");
  const span = capture.span === undefined ? "unset" : `[${capture.span[0]}, ${capture.span[1]})`;
  const text = capture.text === undefined ? "unset" : JSON.stringify(capture.text);
  row.append(element("td", capture.label), element("td", span), element("td", text));
  return row;
}

/** Describes one engine outcome in a single line. */
function describe(outcome: LibraryOutcome | NativeOutcome): string {
  switch (outcome.kind) {
    case "none":
      return "No match.";
    case "skipped":
      return "Skipped: the native RegExp backtracks exponentially on this pattern.";
    case "match": {
      const { index, end, groups } = outcome.match;
      return `Match [${index}, ${end}) ${JSON.stringify(groups[0] ?? "")}`;
    }
  }
}

/** Builds the input tape: one cell per code unit, then an end cell for the position after the last unit. */
function buildTape(input: string): void {
  const cells: HTMLSpanElement[] = [];
  for (let index = 0; index < input.length; index++) {
    cells.push(element("span", input.charAt(index), "cell"));
  }
  cells.push(element("span", "end", "cell end"));
  tapeBox.replaceChildren(...cells);
}

/** Moves the cursor of the input tape to `pos`. */
function markTapeCursor(pos: number): void {
  tapeBox.querySelector(".cursor")?.classList.remove("cursor");
  tapeBox.children[pos]?.classList.add("cursor");
}

/** Lists the threads of the current step, each with its bytecode row and its capture slots. */
function renderThreads(bytecode: readonly string[], threads: readonly TraceThread[]): void {
  threadCount.textContent = `(${threads.length})`;
  threadList.replaceChildren(
    ...threads.map((thread) => {
      const item = element("li", bytecode[thread.pc] ?? "", "thread");
      item.append(element("span", `slots [${thread.slots.join(", ")}]`, "slots"));
      return item;
    }),
  );
}

/** Describes the latest match reached by the trace. */
function describeMatch(matched: number[] | null): string {
  if (matched === null) return "No match reached yet.";
  const [start, end] = matched;
  return `Latest match reached: [${start}, ${end}).`;
}
