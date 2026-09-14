/** A tool-owned failure may retain verified diagnostic content for its result card. */
export class ToolExecutionFailure extends Error {
  constructor(
    error: unknown,
    readonly content: Record<string, unknown>,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "ToolExecutionFailure";
  }
}

/**
 * The host refused the input as given and nothing ran: a payload the tool
 * cannot accept, or an operation that the current durable state does not
 * allow. It is a repair opportunity for the model, not a failing tool, so the
 * runtime counts it on the input-rejection cap instead of the error breaker.
 */
export class ToolInputRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputRejection";
  }
}
