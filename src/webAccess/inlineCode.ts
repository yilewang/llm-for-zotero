// Inline code spans on one Markdown line. Web source markers and links
// inside code are text the user should see as written.

const CODE_TOKEN_PATTERN = /\u0000(\d+)\u0000/g;

export type InlineCodeSpan = { start: number; end: number };

/** Closed inline code spans on one line, backticks included. */
export function findInlineCodeSpans(line: string): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let openEnd = index;
    while (line[openEnd] === "`") openEnd += 1;
    const ticks = openEnd - index;
    let search = openEnd;
    let closeEnd = -1;
    while (search < line.length) {
      if (line[search] !== "`") {
        search += 1;
        continue;
      }
      let runEnd = search;
      while (line[runEnd] === "`") runEnd += 1;
      if (runEnd - search === ticks) {
        closeEnd = runEnd;
        break;
      }
      search = runEnd;
    }
    if (closeEnd < 0) {
      index = openEnd;
      continue;
    }
    spans.push({ start: index, end: closeEnd });
    index = closeEnd;
  }
  return spans;
}

/**
 * Swap each inline code span for a placeholder, so marker patterns never
 * match code. restoreInlineCode puts the spans back.
 */
export function protectInlineCode(line: string): {
  text: string;
  spans: string[];
} {
  const spans: string[] = [];
  let text = "";
  let cursor = 0;
  for (const span of findInlineCodeSpans(line)) {
    text += `${line.slice(cursor, span.start)}\u0000${spans.length}\u0000`;
    spans.push(line.slice(span.start, span.end));
    cursor = span.end;
  }
  return { text: text + line.slice(cursor), spans };
}

export function restoreInlineCode(
  text: string,
  spans: readonly string[],
): string {
  return text.replace(
    CODE_TOKEN_PATTERN,
    (found, index: string) => spans[Number(index)] ?? found,
  );
}

/** The line with inline code blanked out; offsets stay the same. */
export function maskInlineCode(line: string): string {
  let masked = line;
  for (const span of findInlineCodeSpans(line)) {
    masked =
      masked.slice(0, span.start) +
      "\u0000".repeat(span.end - span.start) +
      masked.slice(span.end);
  }
  return masked;
}
