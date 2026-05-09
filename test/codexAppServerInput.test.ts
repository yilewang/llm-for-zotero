import { assert } from "chai";
import {
  buildLegacyCodexAppServerAgentInitialInput,
  buildLegacyCodexAppServerChatInput,
  extractLatestCodexAppServerUserInput,
  isCodexAppServerImageInput,
  prepareCodexAppServerAgentTurn,
  prepareCodexAppServerChatTurn,
} from "../src/utils/codexAppServerInput";
import type { AgentModelMessage } from "../src/agent/types";
import type { ChatMessage } from "../src/utils/llmClient";

describe("codexAppServerInput", function () {
  it("maps data URL chat images to localImage app-server inputs", async function () {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
        ],
      },
    ];

    const originalZotero = globalThis.Zotero;
    const originalIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: unknown;
      }
    ).IOUtils;
    const writes: Array<{ path: string; data: Uint8Array }> = [];

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "C:\\ZoteroData" },
    } as unknown;
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils = {
      exists: async () => false,
      makeDirectory: async () => {},
      write: async (path: string, data: Uint8Array) => {
        writes.push({ path, data });
      },
    };

    const prepared = await prepareCodexAppServerChatTurn(messages);

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils =
      originalIOUtils;

    assert.deepEqual(prepared.historyItemsToInject, []);
    assert.deepEqual(prepared.turnInput[0], {
      type: "text",
      text: "describe this",
    });
    assert.equal(prepared.turnInput[1]?.type, "localImage");
    if (prepared.turnInput[1]?.type !== "localImage") return;
    assert.match(
      prepared.turnInput[1].path,
      /llm-for-zotero-codex-app-server-images\\[a-f0-9]+\.png$/i,
    );
    assert.lengthOf(writes, 1);
  });

  it("maps file URLs to localImage inputs", async function () {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "file:///C:/Users/alice/picture.png" },
          },
        ],
      },
    ];

    const prepared = await prepareCodexAppServerChatTurn(messages);
    const imageInput = prepared.turnInput.find(isCodexAppServerImageInput);

    assert.deepEqual(imageInput, {
      type: "localImage",
      path: "C:\\Users\\alice\\picture.png",
    });
  });

  it("maps chat system prompts to developer instructions", async function () {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "Use the selected paper context.",
      },
      {
        role: "assistant",
        content: "I already inspected the abstract.",
      },
      {
        role: "user",
        content: "What changed?",
      },
    ];

    const prepared = await prepareCodexAppServerChatTurn(messages);

    assert.equal(
      prepared.developerInstructions,
      "Use the selected paper context.",
    );
    assert.deepEqual(prepared.historyItemsToInject, [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I already inspected the abstract.",
          },
        ],
      },
    ]);
    assert.deepEqual(prepared.turnInput, [
      {
        type: "text",
        text: "What changed?",
      },
    ]);
  });

  it("merges additional chat system messages into developer instructions", async function () {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "Use the selected paper context.",
      },
      {
        role: "system",
        content: "Document Context:\nFull text from Zotero text mode.",
      },
      {
        role: "user",
        content: "Summarize the paper.",
      },
    ];

    const prepared = await prepareCodexAppServerChatTurn(messages);

    assert.equal(
      prepared.developerInstructions,
      "Use the selected paper context.\n\nDocument Context:\nFull text from Zotero text mode.",
    );
    assert.deepEqual(prepared.historyItemsToInject, []);
    assert.deepEqual(prepared.turnInput, [
      {
        type: "text",
        text: "Summarize the paper.",
      },
    ]);
  });

  it("preserves non-system chat messages before the latest user in order", async function () {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "Use the selected paper context.",
      },
      {
        role: "system",
        content: "Document Context:\nFull text from Zotero text mode.",
      },
      {
        role: "user",
        content: "Earlier question.",
      },
      {
        role: "assistant",
        content: "Earlier answer.",
      },
      {
        role: "user",
        content: "What changed?",
      },
    ];

    const prepared = await prepareCodexAppServerChatTurn(messages);

    assert.equal(
      prepared.developerInstructions,
      "Use the selected paper context.\n\nDocument Context:\nFull text from Zotero text mode.",
    );
    assert.deepEqual(prepared.historyItemsToInject, [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Earlier question.",
          },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Earlier answer.",
          },
        ],
      },
    ]);
    assert.deepEqual(prepared.turnInput, [
      {
        type: "text",
        text: "What changed?",
      },
    ]);
  });

  it("keeps the latest user message images in agent mode", async function () {
    const messages: AgentModelMessage[] = [
      {
        role: "assistant",
        content: "previous",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,BBBB" },
          },
        ],
      },
    ];

    const originalZotero = globalThis.Zotero;
    const originalIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: unknown;
      }
    ).IOUtils;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "C:\\ZoteroData" },
    } as unknown;
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils = {
      exists: async () => true,
      makeDirectory: async () => {},
      write: async () => {},
    };

    const input = await extractLatestCodexAppServerUserInput(messages);

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils =
      originalIOUtils;

    assert.deepEqual(input[0], {
      type: "text",
      text: "summarize",
    });
    assert.equal(input[1]?.type, "localImage");
  });

  it("maps the system prompt to developer instructions and injects only seeded history", async function () {
    const messages: AgentModelMessage[] = [
      {
        role: "system",
        content: "Follow Zotero-specific tool guidance.",
      },
      {
        role: "assistant",
        content: "I can inspect your library.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize this figure." },
          {
            type: "image_url",
            image_url: { url: "file:///C:/Users/alice/figure.png" },
          },
        ],
      },
    ];

    const prepared = await prepareCodexAppServerAgentTurn(messages);

    assert.equal(
      prepared.developerInstructions,
      "Follow Zotero-specific tool guidance.",
    );
    assert.deepEqual(prepared.historyItemsToInject, [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I can inspect your library.",
          },
        ],
      },
    ]);
    assert.deepEqual(prepared.turnInput[0], {
      type: "text",
      text: "Summarize this figure.",
    });
    assert.deepEqual(prepared.turnInput[1], {
      type: "localImage",
      path: "C:\\Users\\alice\\figure.png",
    });
  });

  it("builds legacy flattened chat input for older app-server binaries", async function () {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "Use the selected paper context.",
      },
      {
        role: "assistant",
        content: "I already inspected the abstract.",
      },
      {
        role: "user",
        content: "What changed?",
      },
    ];

    const input = await buildLegacyCodexAppServerChatInput(messages);

    assert.deepEqual(input, [
      {
        type: "text",
        text: "System:\nUse the selected paper context.",
      },
      {
        type: "text",
        text: "Assistant:\nI already inspected the abstract.",
      },
      {
        type: "text",
        text: "User:\nWhat changed?",
      },
    ]);
  });

  it("builds legacy flattened first-turn agent input for older app-server binaries", async function () {
    const messages: AgentModelMessage[] = [
      {
        role: "system",
        content: "Follow Zotero-specific tool guidance.",
      },
      {
        role: "assistant",
        content: "I can inspect your library.",
      },
      {
        role: "user",
        content: "Summarize this note.",
      },
    ];

    const input = await buildLegacyCodexAppServerAgentInitialInput(messages);

    assert.deepEqual(input, [
      {
        type: "text",
        text: "System:\nFollow Zotero-specific tool guidance.",
      },
      {
        type: "text",
        text: "Assistant:\nI can inspect your library.",
      },
      {
        type: "text",
        text: "User:\nSummarize this note.",
      },
    ]);
  });

  it("can omit the system prompt from legacy flattened agent input when app-server instructions are supported", async function () {
    const messages: AgentModelMessage[] = [
      {
        role: "system",
        content: "Follow Zotero-specific tool guidance.",
      },
      {
        role: "assistant",
        content: "I can inspect your library.",
      },
      {
        role: "user",
        content: "Summarize this note.",
      },
    ];

    const input = await buildLegacyCodexAppServerAgentInitialInput(messages, {
      includeSystem: false,
    });

    assert.deepEqual(input, [
      {
        type: "text",
        text: "Assistant:\nI can inspect your library.",
      },
      {
        type: "text",
        text: "User:\nSummarize this note.",
      },
    ]);
  });
});
