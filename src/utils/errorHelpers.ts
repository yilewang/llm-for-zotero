/**
 * Shared error handling utilities.
 *
 * Replaces silent `catch {}` blocks with logged catches that preserve
 * debuggability while still allowing graceful degradation.
 */

/**
 * Log a caught error with a human-readable context string.
 * Use this in catch blocks instead of empty `catch {}`.
 */
export function logCatch(context: string, err: unknown): void {
  try {
    ztoolkit.log(`LLM: ${context}`, err);
  } catch {
    // If ztoolkit isn't available (e.g. early init), fall back to console
    try {
      console.warn(`[llm-for-zotero] ${context}`, err);
    } catch {
      // truly nothing we can do
    }
  }
}
