export function formatActionLabel(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveActionCompletionStatusText(params: {
  actionName: string;
  lastProgressSummary?: string | null;
}): string {
  const summary = params.lastProgressSummary?.trim();
  if (summary) {
    return summary;
  }
  return `${formatActionLabel(params.actionName)} complete`;
}
