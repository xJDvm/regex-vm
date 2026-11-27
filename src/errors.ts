/**
 * Error thrown when a pattern is malformed or uses a construct regex-vm does not support.
 */
export class RegexSyntaxError extends SyntaxError {
  /** Offset, in UTF-16 code units, of the construct that caused the error. */
  readonly position: number;

  /**
   * @param what - Human-readable description of the problem.
   * @param position - Offset in the pattern where the problem starts.
   */
  constructor(what: string, position: number) {
    super(`${what} at position ${position}`);
    this.name = "RegexSyntaxError";
    this.position = position;
  }
}
