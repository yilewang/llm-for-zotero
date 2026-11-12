/**
 * An HTTP `retry-after` value (seconds, or an HTTP date) in milliseconds, or
 * undefined when it names no wait.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number,
): number | undefined {
  const raw = (value || "").trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * The error a failed provider request throws: its message starts with the
 * HTTP status, as callers parse it, and it carries the status and the wait
 * the provider asked for, so a retry can honor it.
 */
export function providerHttpError(
  response: Pick<Response, "status" | "statusText"> & {
    headers?: { get?: (name: string) => string | null };
  },
  url: string,
  body: string,
): Error & { status: number; retryAfterMs?: number } {
  const error = new Error(
    `${response.status} ${response.statusText} (${url}) - ${body}`,
  ) as Error & { status: number; retryAfterMs?: number };
  error.status = response.status;
  let header: string | null | undefined;
  try {
    header = response.headers?.get?.("retry-after");
  } catch {
    header = undefined;
  }
  const retryAfterMs = parseRetryAfterMs(header, Date.now());
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}
