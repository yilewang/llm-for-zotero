import type { WebAccessErrorCode } from "./types";

export class WebAccessError extends Error {
  constructor(
    message: string,
    readonly code: WebAccessErrorCode,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "WebAccessError";
  }
}
