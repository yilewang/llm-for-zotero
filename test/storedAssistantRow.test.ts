import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Message } from "../src/modules/contextPanel/types";
import { toStoredAssistantRow } from "../src/modules/contextPanel/storedAssistantRow";

/**
 * The plain-chat flows write the assistant row from four places: the send
 * flow, and the retry flow's completion, cancel, and interrupted-error paths.
 * The store UPDATE overwrites every column, so an omitted key is written as
 * NULL; key presence matters as much as the values. These tests pin each
 * site's row to the object literal it wrote before the shared builder.
 */

type ContextSnapshot = { contextTokens?: number; contextWindow?: number };

// --- The four literals exactly as chat.ts wrote them before the builder. ---

function oldSendRow(m: Message, conversationGeneration: number) {
  return {
    conversationGeneration,
    role: "assistant",
    text: m.text,
    timestamp: m.timestamp,
    runMode: m.runMode,
    agentRunId: m.agentRunId,
    documentId: m.documentId,
    planDocumentId: m.planDocumentId,
    modelName: m.modelName,
    modelEntryId: m.modelEntryId,
    modelProviderLabel: m.modelProviderLabel,
    interrupted: m.interrupted,
    completionStatus: m.completionStatus,
    completionReason: m.completionReason,
    reasoningSummary: m.reasoningSummary,
    reasoningDetails: m.reasoningDetails,
    webchatRunState: m.webchatRunState,
    webchatCompletionReason: m.webchatCompletionReason,
    webchatChatUrl: m.webchatChatUrl,
    webchatChatId: m.webchatChatId,
    quoteCitations: m.quoteCitations,
    generatedImages: m.generatedImages,
    compactMarker: m.compactMarker,
  };
}

function oldRetryCompleteRow(
  m: Message,
  conversationGeneration: number,
  latestContextSnapshot: ContextSnapshot | undefined,
) {
  return {
    conversationGeneration,
    text: m.text,
    timestamp: m.timestamp,
    runMode: m.runMode,
    agentRunId: m.agentRunId,
    documentId: m.documentId,
    planDocumentId: m.planDocumentId,
    interrupted: m.interrupted,
    completionStatus: m.completionStatus,
    completionReason: m.completionReason,
    modelName: m.modelName,
    modelEntryId: m.modelEntryId,
    modelProviderLabel: m.modelProviderLabel,
    reasoningSummary: m.reasoningSummary,
    reasoningDetails: m.reasoningDetails,
    compactMarker: m.compactMarker,
    contextTokens: latestContextSnapshot?.contextTokens,
    contextWindow: latestContextSnapshot?.contextWindow,
    quoteCitations: m.quoteCitations,
    generatedImages: m.generatedImages,
  };
}

function oldRetryCancelRow(
  m: Message,
  conversationGeneration: number,
  latestContextSnapshot: ContextSnapshot | undefined,
) {
  return {
    conversationGeneration,
    text: m.text,
    timestamp: m.timestamp,
    runMode: m.runMode,
    agentRunId: m.agentRunId,
    documentId: m.documentId,
    planDocumentId: m.planDocumentId,
    interrupted: m.interrupted,
    modelName: m.modelName,
    modelEntryId: m.modelEntryId,
    modelProviderLabel: m.modelProviderLabel,
    reasoningSummary: m.reasoningSummary,
    reasoningDetails: m.reasoningDetails,
    compactMarker: m.compactMarker,
    contextTokens: latestContextSnapshot?.contextTokens,
    contextWindow: latestContextSnapshot?.contextWindow,
    quoteCitations: m.quoteCitations,
    generatedImages: m.generatedImages,
  };
}

function oldRetryInterruptedRow(
  m: Message,
  conversationGeneration: number,
  latestContextSnapshot: ContextSnapshot | undefined,
) {
  return {
    conversationGeneration,
    text: m.text,
    timestamp: m.timestamp,
    runMode: m.runMode,
    agentRunId: m.agentRunId,
    interrupted: m.interrupted,
    modelName: m.modelName,
    modelEntryId: m.modelEntryId,
    modelProviderLabel: m.modelProviderLabel,
    reasoningSummary: m.reasoningSummary,
    reasoningDetails: m.reasoningDetails,
    compactMarker: m.compactMarker,
    contextTokens: latestContextSnapshot?.contextTokens,
    contextWindow: latestContextSnapshot?.contextWindow,
    quoteCitations: m.quoteCitations,
    generatedImages: m.generatedImages,
  };
}

// --- The four sites as chat.ts now writes them (builder + extension). ---

function newSendRow(
  m: Message,
  conversationGeneration: number,
  latestContextSnapshot: ContextSnapshot | undefined,
) {
  return {
    ...toStoredAssistantRow(m, conversationGeneration),
    role: "assistant" as const,
    documentId: m.documentId,
    planDocumentId: m.planDocumentId,
    completionStatus: m.completionStatus,
    completionReason: m.completionReason,
    webchatRunState: m.webchatRunState,
    webchatCompletionReason: m.webchatCompletionReason,
    webchatChatUrl: m.webchatChatUrl,
    webchatChatId: m.webchatChatId,
    contextTokens: latestContextSnapshot?.contextTokens,
    contextWindow: latestContextSnapshot?.contextWindow,
  };
}

function newRetryCompleteRow(
  m: Message,
  conversationGeneration: number,
  latestContextSnapshot: ContextSnapshot | undefined,
) {
  return {
    ...toStoredAssistantRow(m, conversationGeneration),
    documentId: m.documentId,
    planDocumentId: m.planDocumentId,
    completionStatus: m.completionStatus,
    completionReason: m.completionReason,
    contextTokens: latestContextSnapshot?.contextTokens,
    contextWindow: latestContextSnapshot?.contextWindow,
  };
}

function newRetryCancelRow(
  m: Message,
  conversationGeneration: number,
  latestContextSnapshot: ContextSnapshot | undefined,
) {
  return {
    ...toStoredAssistantRow(m, conversationGeneration),
    documentId: m.documentId,
    planDocumentId: m.planDocumentId,
    contextTokens: latestContextSnapshot?.contextTokens,
    contextWindow: latestContextSnapshot?.contextWindow,
  };
}

function newRetryInterruptedRow(
  m: Message,
  conversationGeneration: number,
  latestContextSnapshot: ContextSnapshot | undefined,
) {
  return {
    ...toStoredAssistantRow(m, conversationGeneration),
    contextTokens: latestContextSnapshot?.contextTokens,
    contextWindow: latestContextSnapshot?.contextWindow,
  };
}

const fullMessage: Message = {
  id: 42,
  conversationGeneration: 99,
  role: "assistant",
  text: "Answer text",
  timestamp: 1_700_000_000_000,
  runMode: "chat",
  agentRunId: "run-1",
  documentId: "doc-1",
  planDocumentId: "plan-1",
  modelName: "gpt-x",
  modelEntryId: "entry-1",
  modelProviderLabel: "Provider",
  interrupted: true,
  completionStatus: "incomplete",
  completionReason: "output_limit",
  reasoningSummary: "summary",
  reasoningDetails: "details",
  reasoningOpen: true,
  webchatRunState: "done",
  webchatCompletionReason: "settled",
  webchatChatUrl: "https://example.test/c/1",
  webchatChatId: "chat-1",
  quoteCitations: [],
  generatedImages: [],
  compactMarker: false,
  streaming: false,
  selectedText: "not part of an assistant row",
  forcedSkillIds: ["skill-a"],
  modelAttachments: [],
  attachments: [],
};

// A message with every optional field absent: each row key must still be
// present, with the value undefined, because the store writes it as NULL.
const sparseMessage: Message = {
  role: "assistant",
  text: "",
  timestamp: 5,
};

const snapshot: ContextSnapshot = { contextTokens: 1200, contextWindow: 8000 };

function assertSameRow(actual: object, expected: object) {
  assert.deepStrictEqual(
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
  );
  assert.deepStrictEqual(actual, expected);
  for (const key of Object.keys(expected)) {
    assert.strictEqual(
      (actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key],
      `value of ${key}`,
    );
  }
}

describe("toStoredAssistantRow", function () {
  it("builds only the fields that every plain-chat assistant row writes", function () {
    assert.deepStrictEqual(
      Object.keys(toStoredAssistantRow(fullMessage, 7)).sort(),
      [
        "agentRunId",
        "compactMarker",
        "conversationGeneration",
        "generatedImages",
        "interrupted",
        "modelEntryId",
        "modelName",
        "modelProviderLabel",
        "quoteCitations",
        "reasoningDetails",
        "reasoningSummary",
        "runMode",
        "text",
        "timestamp",
      ],
    );
  });

  it("takes the conversation generation from the argument, not the message", function () {
    assert.strictEqual(
      toStoredAssistantRow(fullMessage, 7).conversationGeneration,
      7,
    );
  });

  it("does not write modelAttachments (no assistant site wrote it before)", function () {
    for (const row of [
      newSendRow(fullMessage, 7, snapshot),
      newRetryCompleteRow(fullMessage, 7, snapshot),
      newRetryCancelRow(fullMessage, 7, snapshot),
      newRetryInterruptedRow(fullMessage, 7, snapshot),
    ]) {
      assert.isFalse(
        Object.prototype.hasOwnProperty.call(row, "modelAttachments"),
      );
    }
  });

  for (const [label, message] of [
    ["a full message", fullMessage],
    ["a sparse message", sparseMessage],
  ] as const) {
    describe(`for ${label}`, function () {
      for (const snap of [snapshot, undefined]) {
        const snapLabel = snap ? "with" : "without";
        it(`send row equals the old send literal plus the context snapshot (${snapLabel} one)`, function () {
          // The old send literal omitted the snapshot, so a reopened chat
          // showed an older turn's context count (B2).
          assertSameRow(newSendRow(message, 7, snap), {
            ...oldSendRow(message, 7),
            contextTokens: snap?.contextTokens,
            contextWindow: snap?.contextWindow,
          });
        });

        it(`retry completion row equals the old literal (${snapLabel} a context snapshot)`, function () {
          assertSameRow(
            newRetryCompleteRow(message, 7, snap),
            oldRetryCompleteRow(message, 7, snap),
          );
        });

        it(`retry cancel row equals the old literal (${snapLabel} a context snapshot)`, function () {
          assertSameRow(
            newRetryCancelRow(message, 7, snap),
            oldRetryCancelRow(message, 7, snap),
          );
        });

        it(`retry interrupted row equals the old literal and still omits document and completion keys (${snapLabel} a context snapshot)`, function () {
          const row = newRetryInterruptedRow(message, 7, snap);
          assertSameRow(row, oldRetryInterruptedRow(message, 7, snap));
          for (const omitted of [
            "documentId",
            "planDocumentId",
            "completionStatus",
            "completionReason",
          ]) {
            assert.isFalse(
              Object.prototype.hasOwnProperty.call(row, omitted),
              omitted,
            );
          }
        });
      }
    });
  }
});

/**
 * The shapes above mirror the call sites; this check ties them to chat.ts so a
 * site cannot gain or lose an extension key without this file changing too.
 */
describe("chat.ts assistant-row sites", function () {
  const source = readFileSync(
    join(__dirname, "../src/modules/contextPanel/chat.ts"),
    "utf8",
  );

  function extensionKeysAfterEachBuilderCall(): string[][] {
    const marker =
      "...toStoredAssistantRow(assistantMessage, conversationGeneration),";
    const sites: string[][] = [];
    let from = 0;
    for (;;) {
      const at = source.indexOf(marker, from);
      if (at < 0) break;
      const end = findLiteralEnd(at + marker.length);
      const body = source.slice(at + marker.length, end);
      sites.push(
        [...body.matchAll(/^\s*([A-Za-z]+):/gm)]
          .map((match) => match[1])
          .sort(),
      );
      from = at + marker.length;
    }
    return sites;
  }

  function findLiteralEnd(start: number): number {
    // Walk forward from the spread to the brace that closes its object literal.
    let depth = 1;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      else if (ch === "}" || ch === ")" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return source.length;
  }

  it("has exactly the four plain-chat sites with their old extension keys", function () {
    const sites = extensionKeysAfterEachBuilderCall();
    assert.deepStrictEqual(sites, [
      // Retry cancel (finalizeCancelledAssistant).
      ["contextTokens", "contextWindow", "documentId", "planDocumentId"],
      // Retry completion.
      [
        "completionReason",
        "completionStatus",
        "contextTokens",
        "contextWindow",
        "documentId",
        "planDocumentId",
      ],
      // Retry error with partial output (interrupted).
      ["contextTokens", "contextWindow"],
      // Send (persistAssistantOnce).
      [
        "completionReason",
        "completionStatus",
        "contextTokens",
        "contextWindow",
        "documentId",
        "planDocumentId",
        "role",
        "webchatChatId",
        "webchatChatUrl",
        "webchatCompletionReason",
        "webchatRunState",
      ],
    ]);
  });
});
