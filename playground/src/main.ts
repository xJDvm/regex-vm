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

/** Characters of pattern shown on each side of the caret when a syntax error is reported. */
const CARET_CONTEXT = 40;

const VERDICT_TEXT: Record<Verdict, string> = {
  agree: "Agrees with the native RegExp.",
  differ: "Differs from the native RegExp.",
  unchecked: "Not compared: the native RegExp is skipped for this pattern.",
};

const patternInput = requireElement("pattern", HTMLInputElement);
const testInput = requireElement("test-input", HTMLInputElement);
const presetList = requireElement("presets", HTMLDivElement);
const counter = requireElement("counter", HTMLSpanElement);
const errorBox = requireElement("error", HTMLElement);
const bytecodeList = requireElement("bytecode", HTMLOListElement);
const captureBody = requireElement("captures", HTMLTableSectionElement);
const libraryResult = requireElement("match-result", HTMLParagraphElement);
const nativeResult = requireElement("native-result", HTMLParagraphElement);
const verdictLine = requireElement("verdict", HTMLParagraphElement);

for (const preset of PRESETS) presetList.append(presetButton(preset));
patternInput.addEventListener("input", refresh);
testInput.addEventListener("input", refresh);

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
function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
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

/** Re-analyses the current inputs and redraws every panel. */
function refresh(): void {
  const pattern = patternInput.value;
  const input = testInput.value;
  counter.textContent = `${input.length} / ${MAX_INPUT_LENGTH}`;
  render(pattern, analyze(pattern, input, isCatastrophic(pattern)));
}

/** Redraws every output panel for one analysis. */
function render(pattern: string, analysis: Analysis): void {
  if (analysis.ok) {
    errorBox.hidden = true;
    errorBox.replaceChildren();
    fill(bytecodeList, analysis.bytecode.map(bytecodeRow));
    fill(captureBody, analysis.captures.map(captureLine));
    libraryResult.textContent = describe(analysis.library);
    nativeResult.textContent = describe(analysis.native);
    verdictLine.textContent = VERDICT_TEXT[analysis.verdict];
    return;
  }
  renderError(pattern, analysis.message, analysis.position);
  fill(bytecodeList, []);
  fill(captureBody, []);
  libraryResult.textContent = "No result: the pattern has a syntax error.";
  nativeResult.textContent = "No result: the pattern has a syntax error.";
  verdictLine.textContent = "";
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
