import { HTML_NS } from "../../utils/domHelpers";
import type { Message } from "./types";
import type { ResponseActionTarget } from "./state";
import { sanitizeText, setStatus } from "./textUtils";
import { renderAssistantRichText } from "./assistantRichText";
import { renderAssistantGeneratedImagesInto } from "./generatedImageRender";
import { openStandaloneDocumentWindow } from "./standaloneDocumentWindow";

const ROOT_ID = "llmforzotero-standalone-response-document-root";

function responseWindowTitle(modelName: string): string {
  const model = sanitizeText(modelName || "").trim();
  return model && model !== "unknown"
    ? `Response from ${model}`
    : "Model response";
}

function reportSourceStatus(
  sourceBody: Element,
  message: string,
  level: "ready" | "warning" | "error",
): void {
  const status = sourceBody.querySelector("#llm-status") as HTMLElement | null;
  if (status) setStatus(status, message, level);
}

function buildAssistantMessage(target: ResponseActionTarget): Message {
  return {
    role: "assistant",
    text: target.contentText,
    timestamp: Math.floor(Number(target.assistantTimestamp || 0)),
    modelName: target.modelName,
    agentRunId: target.agentRunId,
    quoteCitations: target.quoteCitations,
    quoteDisplayOverride: {
      markdown: target.contentText,
      quoteCitations: target.quoteCitations,
    },
  };
}

function buildPairedUserMessage(target: ResponseActionTarget): Message | null {
  if (!target.queryText && !target.paperContexts?.length) return null;
  return {
    role: "user",
    text: target.queryText || "",
    timestamp: Math.floor(Number(target.userTimestamp || 0)),
    paperContexts: target.paperContexts,
  };
}

function renderResponseDocument(
  doc: Document,
  root: HTMLElement,
  sourceBody: Element,
  target: ResponseActionTarget,
): void {
  const titleText = responseWindowTitle(target.modelName);
  const assistantMessage = buildAssistantMessage(target);
  const pairedUserMessage = buildPairedUserMessage(target);
  const webSourceAnchors = target.webSourceAnchors || [];

  root.className =
    "llm-plan-document-window-root llm-response-document-window-root";
  const article = doc.createElementNS(HTML_NS, "article") as HTMLElement;
  article.className =
    "llm-plan-markdown llm-plan-document-window-content llm-response-document-window-content";
  const title = doc.createElementNS(HTML_NS, "h1") as HTMLHeadingElement;
  title.className =
    "llm-plan-document-window-title llm-response-document-window-title";
  title.textContent = titleText;
  article.appendChild(title);

  if (target.contentText.trim()) {
    const content = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    content.className = "llm-response-document-markdown";
    renderAssistantRichText({
      body: root,
      panelItem: target.item,
      bubble: content,
      assistantMessage,
      pairedUserMessage,
      webSourceAnchors,
    });
    article.appendChild(content);
  }

  const actionStatus = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  actionStatus.className = "llm-response-document-action-status";
  actionStatus.setAttribute("role", "status");
  const setActionStatus = (
    message: string,
    level: "ready" | "warning" | "error",
  ) => {
    actionStatus.textContent = message;
    actionStatus.dataset.level = level;
    if (!actionStatus.isConnected) article.appendChild(actionStatus);
    if (level === "error") reportSourceStatus(sourceBody, message, level);
  };
  renderAssistantGeneratedImagesInto(article, target.generatedImages, doc, {
    wrapClassName: "llm-response-document-generated-images",
    onImageActionStatus: setActionStatus,
  });
  root.replaceChildren(article);
}

export function openStandaloneResponseDocument(
  sourceBody: Element,
  target: ResponseActionTarget,
): boolean {
  const sourceDoc = sourceBody.ownerDocument;
  const assistantTimestamp = Math.floor(Number(target.assistantTimestamp || 0));
  if (!sourceDoc || !assistantTimestamp) return false;
  const conversationKey = Math.floor(Number(target.conversationKey || 0));
  const itemId = Math.floor(Number(target.item?.id || 0));
  const responseKey = `${conversationKey || itemId || "unknown"}-${assistantTimestamp}`;
  const title = responseWindowTitle(target.modelName);
  return openStandaloneDocumentWindow({
    sourceDoc,
    chromeDocument: "standaloneResponseDocument.xhtml",
    windowName: `llmforzotero-response-document-${responseKey}`,
    rootId: ROOT_ID,
    title,
    render: (doc, root) =>
      renderResponseDocument(doc, root, sourceBody, target),
    onInitializationFailure: (error) => {
      ztoolkit.log("LLM: Failed to initialize response document window", error);
      reportSourceStatus(
        sourceBody,
        "The response window could not be opened",
        "error",
      );
    },
  });
}
