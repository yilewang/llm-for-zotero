/** Bind only the exact block emitted by document finalization, for display.
 * Ambiguous provenance and ordinary prose never acquire a quote certificate.
 */
export function bindDocumentQuotesForDisplay(
  markdown: string,
  quotes: readonly { id: string; quoteText: string }[],
): string {
  const byBlock = new Map<string, string[]>();
  for (const quote of quotes) {
    const block = quote.quoteText
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    byBlock.set(block, [...(byBlock.get(block) || []), quote.id]);
  }
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let fence = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = "";
      output.push(line);
      continue;
    }
    if (fence || !line.startsWith(">")) {
      output.push(line);
      continue;
    }
    const block = [line];
    while (lines[index + 1]?.startsWith(">")) block.push(lines[++index]);
    const text = block.join("\n");
    const ids = byBlock.get(text);
    output.push(ids?.length === 1 ? `[[quote:${ids[0]}]]` : text);
  }
  return output.join("\n");
}
