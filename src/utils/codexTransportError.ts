export function isCodexFetchTransportError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    name === "TypeError" &&
    /networkerror|failed to fetch|fetch resource|network request failed/i.test(
      message,
    )
  );
}
