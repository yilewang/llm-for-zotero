import type { AgentPendingField } from "../../../agent/types";
import { buildTextDiffPreview } from "./diffPreview";
export function renderDiffPreviewField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "diff_preview" }>,
): {
  element: HTMLDivElement;
  update: (nextAfter: string) => void;
} {
  const wrap = doc.createElement("div");
  wrap.className = "llm-agent-hitl-diff";

  const body = doc.createElement("div");
  body.className = "llm-agent-hitl-diff-body";
  wrap.appendChild(body);

  const update = (nextAfter: string) => {
    body.replaceChildren();
    const lines = buildTextDiffPreview(field.before || "", nextAfter, {
      contextLines: field.contextLines,
    });
    if (!lines.length) {
      const empty = doc.createElement("div");
      empty.className = "llm-agent-hitl-diff-empty";
      empty.textContent = field.emptyMessage || "No changes.";
      body.appendChild(empty);
      return;
    }

    for (const line of lines) {
      if (line.kind === "gap") {
        const gap = doc.createElement("div");
        gap.className = "llm-agent-hitl-diff-gap";
        gap.textContent = `... ${line.omittedCount} unchanged line${
          line.omittedCount === 1 ? "" : "s"
        } ...`;
        body.appendChild(gap);
        continue;
      }

      const row = doc.createElement("div");
      row.className = `llm-agent-hitl-diff-line llm-agent-hitl-diff-line-${line.kind}`;

      const gutter = doc.createElement("div");
      gutter.className = "llm-agent-hitl-diff-gutter";

      const lineNumber = doc.createElement("span");
      lineNumber.className = "llm-agent-hitl-diff-line-number";
      lineNumber.textContent =
        typeof line.oldLineNumber === "number"
          ? String(line.oldLineNumber)
          : typeof line.newLineNumber === "number"
            ? String(line.newLineNumber)
            : "";

      const marker = doc.createElement("span");
      marker.className = "llm-agent-hitl-diff-marker";
      marker.textContent =
        line.kind === "add" ? "+" : line.kind === "remove" ? "\u2212" : " ";

      gutter.append(lineNumber, marker);

      const content = doc.createElement("pre");
      content.className = "llm-agent-hitl-diff-content";
      for (const segment of line.segments) {
        const segmentEl = doc.createElement("span");
        segmentEl.className =
          segment.kind === "context"
            ? "llm-agent-hitl-diff-segment"
            : `llm-agent-hitl-diff-segment llm-agent-hitl-diff-segment-${segment.kind}`;
        segmentEl.textContent = segment.text;
        content.appendChild(segmentEl);
      }
      if (!content.textContent) {
        content.textContent = " ";
      }

      row.append(gutter, content);
      body.appendChild(row);
    }
  };

  update(field.after || "");
  return { element: wrap, update };
}
