export type DiffPreviewSegmentKind = "context" | "add" | "remove";

export type DiffPreviewSegment = {
  kind: DiffPreviewSegmentKind;
  text: string;
};

export type DiffPreviewLine =
  | {
      kind: "context" | "add" | "remove";
      oldLineNumber: number | null;
      newLineNumber: number | null;
      segments: DiffPreviewSegment[];
    }
  | {
      kind: "gap";
      omittedCount: number;
    };

type SequenceOp<T> =
  | { kind: "context"; before: T; after: T }
  | { kind: "remove"; before: T }
  | { kind: "add"; after: T };

type RawDiffLine = Extract<
  DiffPreviewLine,
  { kind: "context" | "add" | "remove" }
>;

type BuildTextDiffPreviewOptions = {
  contextLines?: number;
};

function normalizeLines(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function tokenizeLine(value: string): string[] {
  return value.match(/\s+|[^\s]+/g) || [];
}

function diffSequence<T>(
  before: readonly T[],
  after: readonly T[],
  equals: (left: T, right: T) => boolean,
): SequenceOp<T>[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    equals(before[prefix] as T, after[prefix] as T)
  ) {
    prefix += 1;
  }

  let beforeSuffix = before.length;
  let afterSuffix = after.length;
  while (
    beforeSuffix > prefix &&
    afterSuffix > prefix &&
    equals(before[beforeSuffix - 1] as T, after[afterSuffix - 1] as T)
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const middleBefore = before.slice(prefix, beforeSuffix);
  const middleAfter = after.slice(prefix, afterSuffix);
  const heights: number[][] = Array.from(
    { length: middleBefore.length + 1 },
    () => Array<number>(middleAfter.length + 1).fill(0),
  );

  for (let row = middleBefore.length - 1; row >= 0; row -= 1) {
    for (let col = middleAfter.length - 1; col >= 0; col -= 1) {
      heights[row][col] = equals(middleBefore[row] as T, middleAfter[col] as T)
        ? heights[row + 1][col + 1] + 1
        : Math.max(heights[row + 1][col], heights[row][col + 1]);
    }
  }

  const ops: SequenceOp<T>[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({
      kind: "context",
      before: before[index] as T,
      after: after[index] as T,
    });
  }

  let row = 0;
  let col = 0;
  while (row < middleBefore.length && col < middleAfter.length) {
    if (equals(middleBefore[row] as T, middleAfter[col] as T)) {
      ops.push({
        kind: "context",
        before: middleBefore[row] as T,
        after: middleAfter[col] as T,
      });
      row += 1;
      col += 1;
      continue;
    }
    if (heights[row + 1][col] >= heights[row][col + 1]) {
      ops.push({
        kind: "remove",
        before: middleBefore[row] as T,
      });
      row += 1;
      continue;
    }
    ops.push({
      kind: "add",
      after: middleAfter[col] as T,
    });
    col += 1;
  }

  while (row < middleBefore.length) {
    ops.push({
      kind: "remove",
      before: middleBefore[row] as T,
    });
    row += 1;
  }

  while (col < middleAfter.length) {
    ops.push({
      kind: "add",
      after: middleAfter[col] as T,
    });
    col += 1;
  }

  for (
    let index = 0;
    index < before.length - beforeSuffix && index < after.length - afterSuffix;
    index += 1
  ) {
    ops.push({
      kind: "context",
      before: before[beforeSuffix + index] as T,
      after: after[afterSuffix + index] as T,
    });
  }

  return ops;
}

function collapseSegments(
  segments: DiffPreviewSegment[],
): DiffPreviewSegment[] {
  const collapsed: DiffPreviewSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = collapsed[collapsed.length - 1];
    if (previous?.kind === segment.kind) {
      previous.text += segment.text;
      continue;
    }
    collapsed.push({ ...segment });
  }
  return collapsed;
}

function buildLinePairSegments(
  before: string,
  after: string,
): {
  removeSegments: DiffPreviewSegment[];
  addSegments: DiffPreviewSegment[];
} {
  const tokenDiff = diffSequence(
    tokenizeLine(before),
    tokenizeLine(after),
    (left, right) => left === right,
  );
  const removeSegments = collapseSegments(
    tokenDiff
      .filter((entry) => entry.kind !== "add")
      .map((entry) =>
        entry.kind === "remove"
          ? { kind: "remove" as const, text: entry.before }
          : { kind: "context" as const, text: entry.before },
      ),
  );
  const addSegments = collapseSegments(
    tokenDiff
      .filter((entry) => entry.kind !== "remove")
      .map((entry) =>
        entry.kind === "add"
          ? { kind: "add" as const, text: entry.after }
          : { kind: "context" as const, text: entry.after },
      ),
  );

  return {
    removeSegments:
      removeSegments.length > 0
        ? removeSegments
        : [{ kind: "remove", text: before }],
    addSegments:
      addSegments.length > 0 ? addSegments : [{ kind: "add", text: after }],
  };
}

function withDefaultSegment(
  kind: "context" | "add" | "remove",
  text: string,
): DiffPreviewSegment[] {
  return [{ kind, text }];
}

function buildRawDiffLines(before: string, after: string): RawDiffLine[] {
  const ops = diffSequence(
    normalizeLines(before),
    normalizeLines(after),
    (left, right) => left === right,
  );
  const rows: RawDiffLine[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  for (let index = 0; index < ops.length; ) {
    const current = ops[index];
    if (current?.kind === "context") {
      rows.push({
        kind: "context",
        oldLineNumber,
        newLineNumber,
        segments: withDefaultSegment("context", current.before),
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      index += 1;
      continue;
    }

    const removed: Array<{ text: string; oldLineNumber: number }> = [];
    const added: Array<{ text: string; newLineNumber: number }> = [];

    while (ops[index]?.kind === "remove") {
      const op = ops[index];
      if (!op || op.kind !== "remove") break;
      removed.push({
        text: op.before,
        oldLineNumber,
      });
      oldLineNumber += 1;
      index += 1;
    }
    while (ops[index]?.kind === "add") {
      const op = ops[index];
      if (!op || op.kind !== "add") break;
      added.push({
        text: op.after,
        newLineNumber,
      });
      newLineNumber += 1;
      index += 1;
    }

    const pairCount = Math.min(removed.length, added.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const beforeLine = removed[pairIndex];
      const afterLine = added[pairIndex];
      if (!beforeLine || !afterLine) continue;
      const segments = buildLinePairSegments(beforeLine.text, afterLine.text);
      rows.push({
        kind: "remove",
        oldLineNumber: beforeLine.oldLineNumber,
        newLineNumber: null,
        segments: segments.removeSegments,
      });
      rows.push({
        kind: "add",
        oldLineNumber: null,
        newLineNumber: afterLine.newLineNumber,
        segments: segments.addSegments,
      });
    }

    for (
      let removeIndex = pairCount;
      removeIndex < removed.length;
      removeIndex += 1
    ) {
      const line = removed[removeIndex];
      if (!line) continue;
      rows.push({
        kind: "remove",
        oldLineNumber: line.oldLineNumber,
        newLineNumber: null,
        segments: withDefaultSegment("remove", line.text),
      });
    }

    for (let addIndex = pairCount; addIndex < added.length; addIndex += 1) {
      const line = added[addIndex];
      if (!line) continue;
      rows.push({
        kind: "add",
        oldLineNumber: null,
        newLineNumber: line.newLineNumber,
        segments: withDefaultSegment("add", line.text),
      });
    }
  }

  return rows;
}

export function buildTextDiffPreview(
  before: string,
  after: string,
  options: BuildTextDiffPreviewOptions = {},
): DiffPreviewLine[] {
  const rawLines = buildRawDiffLines(before, after);
  const changedIndexes = rawLines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (!changedIndexes.length) {
    return [];
  }

  const contextLines = Math.max(0, options.contextLines ?? 2);
  const visible = new Set<number>();
  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - contextLines);
    const end = Math.min(rawLines.length - 1, changedIndex + contextLines);
    for (let index = start; index <= end; index += 1) {
      visible.add(index);
    }
  }

  const result: DiffPreviewLine[] = [];
  let index = 0;
  while (index < rawLines.length) {
    if (visible.has(index)) {
      result.push(rawLines[index] as DiffPreviewLine);
      index += 1;
      continue;
    }
    const start = index;
    while (index < rawLines.length && !visible.has(index)) {
      index += 1;
    }
    result.push({
      kind: "gap",
      omittedCount: index - start,
    });
  }

  return result;
}
