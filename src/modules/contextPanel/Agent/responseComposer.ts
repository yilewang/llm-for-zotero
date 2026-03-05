import { sanitizeText } from "../textUtils";
import { MAX_RESPONDER_TOOL_LOG_LINES } from "./config";
import type { AgentToolLog, UiActionDirective } from "./types";

function buildUiActionInstruction(action: UiActionDirective): string {
  if (action.type === "show_note_review") {
    return `${action.targetLabel}: review the note panel, edit if needed, then click Save to Zotero.`;
  }
  if (action.type === "show_metadata_review") {
    return `${action.targetLabel}: review proposed metadata fields, then click Accept.`;
  }
  return `${action.targetLabel}: ${action.message}`;
}

export function buildResponderContextBlock(params: {
  responderPrompt: string;
  promptSource: "file" | "fallback";
  toolLogs: AgentToolLog[];
  uiActions: UiActionDirective[];
  shouldOfferDeepenCTA?: boolean;
}): string {
  const responderPrompt = sanitizeText(params.responderPrompt || "").trim();
  const toolLogLines = params.toolLogs
    .slice(-MAX_RESPONDER_TOOL_LOG_LINES)
    .map((log) => log.summary);
  const uiActionLines = params.uiActions.map((action) =>
    buildUiActionInstruction(action),
  );

  const lines = [
    "Agent Responder Guidance",
    `- Prompt source: ${params.promptSource}`,
    "",
    "Responder instructions:",
    responderPrompt || "(none)",
    "",
    "Router and tool execution summary:",
    ...(toolLogLines.length
      ? toolLogLines.map((line) => `- ${line}`)
      : ["- no tool calls were executed"]),
    "",
    "Reference style requirements:",
    "- Avoid opaque references like 'paper 1/2/3' unless you provide explicit mapping in the same answer.",
    "- Prefer author-year and/or title labels when mentioning examples.",
  ];

  if (uiActionLines.length) {
    lines.push(
      "",
      "Pending UI actions to mention explicitly:",
      ...uiActionLines.map((line) => `- ${line}`),
      "",
      "When writing the final user response, include a clear action sentence for these pending UI actions.",
    );
  }

  if (params.shouldOfferDeepenCTA) {
    lines.push(
      "",
      "If the answer is broad and library-level, end with one optional follow-up sentence offering deeper paper-by-paper analysis on request.",
    );
  }

  return lines.join("\n");
}
