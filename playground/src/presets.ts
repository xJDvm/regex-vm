/** A ready-made pattern and test string, offered as a one-click example. */
export interface Preset {
  /** Button label. */
  readonly name: string;
  /** Pattern text, without slashes or flags. */
  readonly pattern: string;
  /** Test string; at most 200 code units. */
  readonly input: string;
  /** Set when the native `RegExp` backtracks exponentially on this pattern, so the playground must not run it. */
  readonly catastrophic?: true;
}

/** The examples offered by the playground. */
export const PRESETS: readonly Preset[] = [
  {
    name: "Email-like",
    pattern: "[a-z0-9._%+-]+@[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z]{2,}",
    input: "write to jane.doe+news@mail.example.org today",
  },
  {
    name: "Named groups",
    pattern: "(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})",
    input: "released 2026-11-27, patched 2026-12-01",
  },
  {
    name: "Lazy quantifier",
    pattern: "<.+?>",
    input: "<b>bold</b> and <i>italic</i>",
  },
  {
    name: "Alternation order",
    pattern: "cat|category",
    input: "category",
  },
  {
    name: "ReDoS (a+)+b",
    pattern: "(a+)+b",
    input: "a".repeat(64),
    catastrophic: true,
  },
];

/**
 * Whether `pattern` is one of the presets that must not be run on the native engine.
 *
 * @param pattern - Pattern text as typed by the user.
 * @returns `true` when the pattern text equals a catastrophic preset's pattern.
 */
export function isCatastrophic(pattern: string): boolean {
  return PRESETS.some((preset) => preset.catastrophic === true && preset.pattern === pattern);
}
