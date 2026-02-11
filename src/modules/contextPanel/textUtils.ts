import { SELECTED_TEXT_MAX_LENGTH, SELECTED_TEXT_PREVIEW_LENGTH } from "./constants";

export function sanitizeText(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += text[i];
  }
  return out;
}

export function normalizeSelectedText(text: string): string {
  return sanitizeText(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SELECTED_TEXT_MAX_LENGTH);
}

export function truncateSelectedText(text: string): string {
  if (text.length <= SELECTED_TEXT_PREVIEW_LENGTH) return text;
  return `${text.slice(0, SELECTED_TEXT_PREVIEW_LENGTH - 1)}\u2026`;
}

export function buildQuestionWithSelectedText(
  selectedText: string,
  userPrompt: string,
): string {
  const normalizedPrompt =
    userPrompt.trim() || "Please explain this selected text.";
  return `Selected text from the PDF reader:\n"""\n${selectedText}\n"""\n\nUser question:\n${normalizedPrompt}`;
}

export function escapeNoteHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatTime(timestamp: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${hour}:${minute}`;
}

export function setStatus(
  statusEl: HTMLElement,
  text: string,
  variant: "ready" | "sending" | "error",
) {
  statusEl.textContent = text;
  statusEl.className = `llm-status llm-status-${variant}`;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getCurrentLocalTimestamp(): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour12: false,
  }).format(new Date());
}

/**
 * Extract the selected text within a bubble, replacing KaTeX-rendered math
 * with its original LaTeX source wrapped in `$...$` (inline) or `$$...$$`
 * (display).
 */
export function getSelectedTextWithinBubble(
  doc: Document,
  container: HTMLElement,
): string {
  const win = doc.defaultView;
  const selection = win?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (
    !anchorNode ||
    !focusNode ||
    !container.contains(anchorNode) ||
    !container.contains(focusNode)
  ) {
    return "";
  }

  try {
    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    const temp = doc.createElement("div");
    temp.appendChild(fragment);

    const katexEls = Array.from(
      temp.querySelectorAll(".katex"),
    ) as Element[];
    for (const el of katexEls) {
      const ann = el.querySelector(
        'annotation[encoding="application/x-tex"]',
      );
      if (ann) {
        const latex = (ann.textContent || "").trim();
        const mathEl = ann.closest("math");
        const isDisplay = mathEl?.getAttribute("display") === "block";
        el.replaceWith(
          doc.createTextNode(isDisplay ? `$$${latex}$$` : `$${latex}$`),
        );
        continue;
      }
      const mathml = el.querySelector(".katex-mathml");
      if (mathml) mathml.remove();
    }

    const strayMathml = Array.from(
      temp.querySelectorAll(".katex-mathml"),
    ) as Element[];
    for (const el of strayMathml) el.remove();

    return sanitizeText(temp.textContent || "").trim();
  } catch (err) {
    ztoolkit.log("LLM: Selected text extraction failed:", err);
    return "";
  }
}
