import { assert } from "chai";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import type {
  AgentModelMessage,
  AgentRuntimeRequest,
} from "../src/agent/types";
import { buildExternalBridgeContextEnvelopeForTests } from "../src/agent/externalBackendBridge";
import { buildCodexNativeVisibleTurnContextBlockForTests } from "../src/codexAppServer/nativeClient";
import { buildQuestionWithSelectedTextContexts } from "../src/modules/contextPanel/textUtils";
import type {
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
} from "../src/shared/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const selectedTextContext: SelectedTextContext = {
  text: "A highlighted claim on a late PDF page.",
  source: "pdf",
  contextItemId: 77,
  pageIndex: 587,
  pageLabel: "588",
  paperContext: {
    itemId: 70,
    contextItemId: 77,
    title: "Late-page paper",
  },
};

const resolvedAnchor: ResolvedSelectedTextAnchor = {
  contextIndex: 0,
  contextItemId: 77,
  pageIndex: 587,
  pageLabel: "588",
  paperContext: selectedTextContext.paperContext,
  resolution: "chunks",
  primaryChunkIndex: 12,
  preferredChunkIndexes: [11, 12, 13],
  contextText:
    "[preceding local context]\nBefore the claim.\n\n[selected local context]\nThe highlighted claim and its explanation.\n\n[following local context]\nAfter the claim.",
  sourceType: "zotero",
  injectedChars: 151,
};

function messageText(message: AgentModelMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("highlight-aware backend payloads", function () {
  it("renders the stable locator for direct API chat", function () {
    const prompt = buildQuestionWithSelectedTextContexts(
      [selectedTextContext.text],
      ["pdf"],
      "Explain the claim.",
      {
        selectedTextContexts: [selectedTextContext],
        resolvedSelectedTextAnchors: [resolvedAnchor],
      },
    );

    assert.include(prompt, "attachment_id=77");
    assert.include(prompt, "page_label=588");
    assert.include(prompt, "page_index=587");
    assert.include(prompt, "location_resolution=chunks");
    assert.notInclude(prompt, "highlighted claim and its explanation");
    assert.notInclude(prompt, "chunk_index");
  });

  it("appends bounded anchor text for webchat", function () {
    const prompt = buildQuestionWithSelectedTextContexts(
      [selectedTextContext.text],
      ["pdf"],
      "Explain the claim.",
      {
        selectedTextContexts: [selectedTextContext],
        resolvedSelectedTextAnchors: [resolvedAnchor],
        includeAnchorContext: true,
      },
    );

    assert.include(prompt, "Highlight-aware local context:");
    assert.include(prompt, "The highlighted claim and its explanation.");
    assert.include(prompt, "read PDF page 588");
    assert.notInclude(prompt, "primaryChunkIndex");
  });

  it("includes the locator and bounded context in plugin Agent messages", async function () {
    const request: AgentRuntimeRequest = resolvedAgentRequest({
      conversationKey: 30301,
      mode: "agent",
      userText: "Explain the claim.",
      libraryID: 1,
      selectedTextContexts: [selectedTextContext],
      resolvedSelectedTextAnchors: [resolvedAnchor],
      selectedTexts: [selectedTextContext.text],
      selectedTextSources: ["pdf"],
      selectedTextPaperContexts: [selectedTextContext.paperContext],
    });
    const messages = await buildAgentInitialMessages(request, [], []);
    const userMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    const text = messageText(userMessage);

    assert.include(text, "attachment_id=77");
    assert.include(text, "page_label=588");
    assert.include(text, "The highlighted claim and its explanation.");
    assert.include(text, "read PDF page 588");
  });

  it("carries the locator and bounded context through the Claude bridge envelope", function () {
    const envelope = buildExternalBridgeContextEnvelopeForTests({
      conversationKey: 30302,
      mode: "agent",
      userText: "Explain the claim.",
      libraryID: 1,
      selectedTextContexts: [selectedTextContext],
      resolvedSelectedTextAnchors: [resolvedAnchor],
      selectedTexts: [selectedTextContext.text],
      selectedTextSources: ["pdf"],
      selectedTextPaperContexts: [selectedTextContext.paperContext],
    });

    assert.include(envelope.selectedTexts[0]?.locator || "", "page_label=588");
    assert.include(
      envelope.selectedTexts[0]?.localContext || "",
      "The highlighted claim and its explanation.",
    );
    assert.include(envelope.visibleContext || "", "pageIndex=587");
  });

  it("includes anchors in Codex native light-context turns", function () {
    const block = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 30303,
        libraryID: 1,
        libraryName: "My Library",
        kind: "global",
      },
      skillContext: {
        selectedTextContexts: [selectedTextContext],
        resolvedSelectedTextAnchors: [resolvedAnchor],
        selectedTexts: [selectedTextContext.text],
        selectedTextSources: ["pdf"],
        selectedTextPaperContexts: [selectedTextContext.paperContext],
      },
    });

    assert.include(block, "page_label=588");
    assert.include(block, "The highlighted claim and its explanation.");
    assert.include(block, "read PDF page 588");
  });
});
