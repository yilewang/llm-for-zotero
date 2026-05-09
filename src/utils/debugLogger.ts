/**
 * Simple debug logger that works in Zotero environment.
 * Output goes to Error Console and browser console when available.
 */

const PREFIX = "[LLM-SlashDebug]";

export function dbg(message: string, data?: unknown): void {
  const fullMessage =
    data !== undefined
      ? `${PREFIX} ${message} | ${JSON.stringify(data)}`
      : `${PREFIX} ${message}`;
  try {
    ztoolkit?.log?.(fullMessage);
  } catch {
    // ignore
  }
  try {
    console.log(fullMessage);
  } catch {
    // ignore
  }
}

export function dbgError(message: string, error: unknown): void {
  const errorStr = error instanceof Error ? error.message : String(error);
  const fullMessage = `${PREFIX} ERROR: ${message} | ${errorStr}`;
  try {
    ztoolkit?.log?.(fullMessage);
  } catch {
    // ignore
  }
  try {
    console.error(fullMessage);
  } catch {
    // ignore
  }
}
