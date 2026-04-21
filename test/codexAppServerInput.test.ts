import { assert } from "chai";
import {
  buildCodexAppServerAgentInitialInput,
  buildCodexAppServerChatInput,
  extractLatestCodexAppServerUserInput,
  isCodexAppServerImageInput,
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

    const input = await buildCodexAppServerChatInput(messages);

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils =
      originalIOUtils;

    assert.deepEqual(input[0], {
      type: "text",
      text: "User:\ndescribe this",
    });
    assert.equal(input[1]?.type, "localImage");
    if (input[1]?.type !== "localImage") return;
    assert.match(
      input[1].path,
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

    const input = await buildCodexAppServerChatInput(messages);
    const imageInput = input.find(isCodexAppServerImageInput);

    assert.deepEqual(imageInput, {
      type: "localImage",
      path: "C:\\Users\\alice\\picture.png",
    });
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

  it("preserves system prompt and seeded history on the first agent turn", async function () {
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

    const input = await buildCodexAppServerAgentInitialInput(messages);

    assert.deepEqual(input.slice(0, 3), [
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
        text: "User:\nSummarize this figure.",
      },
    ]);
    assert.deepEqual(input[3], {
      type: "localImage",
      path: "C:\\Users\\alice\\figure.png",
    });
  });
});
