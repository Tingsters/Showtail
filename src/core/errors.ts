/**
 * A user-facing CLI error that carries a stable process exit code, so agents
 * driving Showtail can branch on *why* a command failed rather than parsing the
 * message. Plain `Error`s map to code 1; {@link NotInitializedError} maps to 2.
 *
 * Stable codes:
 *   0  success
 *   1  generic error
 *   2  no single usable project could be selected (missing trail/path or ambiguity)
 *   3  verify failed (integrity check did not pass)
 *   4  nothing to do / not connected
 */
export class ShowtailError extends Error {
  readonly code: number;
  readonly errorCode: string;
  readonly nextAction: string;
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    code = 1,
    details?: Record<string, unknown>,
    errorCode = 'COMMAND_FAILED',
    nextAction = 'review-error',
  ) {
    super(message);
    this.name = 'ShowtailError';
    this.code = code;
    this.errorCode = errorCode;
    this.nextAction = nextAction;
    this.details = details;
  }
}
