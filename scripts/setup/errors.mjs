/** The setup refused to go on; nothing has been written yet. */
export const EXIT_REFUSED = 1

/** The command line was wrong. */
export const EXIT_USAGE = 2

/** A failure the setup reports as a message and an exit code instead of a stack trace. */
export class SetupError extends Error {
  constructor(message, exitCode = EXIT_REFUSED) {
    super(message)
    this.exitCode = exitCode
  }
}

/** A `SetupError` for a wrong or missing option. */
export const usageError = (message) => new SetupError(message, EXIT_USAGE)
