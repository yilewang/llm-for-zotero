import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";
import { setCachedModels } from "../src/providers/model-resolver.js";
import { globalPermissionStore } from "../src/permissions/permission-store.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";

function makeStream(items: unknown[]): any {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

function makeFailingStream(error: Error): any {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    close() {},
  };
}

function makeModelProbe(models: unknown[] = []): any {
  return {
    async supportedModels() {
      return models;
    },
    close() {},
    async return() {
      return undefined;
    },
  };
}

const temporaryDirectories = new Set<string>();

async function createPdfFile(
  name = "paper.pdf",
  contents = "%PDF-1.4\n% test\n",
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cc-l4z-pdf-"));
  temporaryDirectories.add(directory);
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function nextEvent(
  iterator: AsyncIterator<any>,
  timeoutMs = 1_000,
): Promise<IteratorResult<any>> {
  return Promise.race([
    iterator.next(),
    new Promise<IteratorResult<any>>((_, reject) => {
      setTimeout(
        () => reject(new Error("Timed out waiting for event")),
        timeoutMs,
      );
    }),
  ]);
}

describe("ClaudeAgentSdkRuntimeClient", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalDefaultMythosModel = process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL;

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalDefaultMythosModel === undefined) {
      delete process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL;
    } else {
      process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL = originalDefaultMythosModel;
    }
    globalPermissionStore.cleanup();
    await Promise.all(
      Array.from(temporaryDirectories, (directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    temporaryDirectories.clear();
  });

  it("passes resume/allowedTools into query options and maps messages", async () => {
    let seenPrompt = "";
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      settingSources: ["user", "project"],
      queryImpl(args) {
        seenPrompt = typeof args.prompt === "string" ? args.prompt : "";
        seenOptions = args.options;
        return makeStream([
          { type: "system", session_id: "session-new", subtype: "init" },
          {
            type: "assistant",
            session_id: "session-new",
            message: { content: [{ type: "text", text: "hi" }] },
          },
          {
            type: "result",
            session_id: "session-new",
            result: "hi",
            is_error: false,
          },
        ]);
      },
    });

    const mcpServers = {
      llm_for_zotero: {
        type: "http",
        url: "http://127.0.0.1:23119/llm-for-zotero/mcp",
        headers: { Authorization: "Bearer token-1" },
      },
    };

    const stream = await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
      providerSessionId: "session-old",
      allowedTools: ["Read", "Bash"],
      mcpServers,
    });

    expect(seenPrompt).toBe("hello");
    expect(seenOptions.resume).toBe("session-old");
    expect(seenOptions.allowedTools).toEqual(["Read", "Bash"]);
    expect(seenOptions.mcpServers).toEqual(mcpServers);

    const types: string[] = [];
    for await (const event of stream.events) {
      types.push(event.type);
    }

    expect(types).toEqual([
      "provider_event",
      "provider_event",
      "provider_event",
      "status",
      "provider_event",
      "message_delta",
      "provider_event",
      "final",
    ]);
  });

  it("pairs each selected snippet with its question in the Claude prompt", async () => {
    let seenPrompt = "";
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenPrompt = typeof args.prompt === "string" ? args.prompt : "";
        return makeStream([
          {
            type: "result",
            session_id: "snippet",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });
    const stream = await runtime.startTurn({
      conversationKey: "conv-snippets",
      userMessage: "What did I send?",
      runtimeRequest: {
        selectedTexts: ["first", "second", "third"],
        selectedTextContexts: [
          { text: "first", userQuery: "First question?" },
          { text: "second" },
          { text: "third", userQuery: "Third question?" },
        ],
      },
    });
    for await (const _event of stream.events) {
      /* drain */
    }
    expect(seenPrompt).toContain(
      "1. first\nQuestion about this text:\nFirst question?",
    );
    expect(seenPrompt).toContain("2. second");
    expect(seenPrompt).toContain(
      "3. third\nQuestion about this text:\nThird question?",
    );
  });

  it("preserves snippet questions with image input and supports legacy text arrays", async () => {
    const prompts: string[] = [];
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl({ prompt }) {
        return {
          async *[Symbol.asyncIterator]() {
            if (typeof prompt === "string") {
              prompts.push(prompt);
            } else {
              for await (const message of prompt) {
                const content = message.message.content;
                if (Array.isArray(content) && content[0]?.type === "text") {
                  prompts.push(content[0].text);
                }
              }
            }
            yield {
              type: "result",
              session_id: "snippet",
              result: "ok",
              is_error: false,
            };
          },
          close() {},
        } as ReturnType<typeof makeStream>;
      },
    });
    for (const runtimeRequest of [
      { selectedTexts: ["legacy"] },
      {
        selectedTextContexts: [
          { text: " ", userQuery: "discarded" },
          { text: "image snippet", userQuery: "image question" },
        ],
        screenshots: ["data:image/png;base64,YQ=="],
      },
    ]) {
      const stream = await runtime.startTurn({
        conversationKey: "conv-snippets-compat",
        userMessage: "",
        runtimeRequest,
      });
      for await (const _event of stream.events) {
        /* drain */
      }
    }
    expect(prompts[0]).toContain("1. legacy");
    expect(prompts[1]).toContain(
      "1. image snippet\nQuestion about this text:\nimage question",
    );
    expect(prompts[1]).not.toContain("discarded");
  });

  it("renders selected Zotero collection and tag scopes in the Claude prompt", async () => {
    let seenPrompt = "";

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenPrompt = typeof args.prompt === "string" ? args.prompt : "";
        return makeStream([
          { type: "system", session_id: "session-scope", subtype: "init" },
          {
            type: "assistant",
            session_id: "session-scope",
            message: { content: [{ type: "text", text: "ok" }] },
          },
          {
            type: "result",
            session_id: "session-scope",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-scope",
      userMessage:
        "can you find the commonality of the papers inside this folder?",
      runtimeRequest: {
        selectedCollectionContexts: [
          {
            collectionId: 42,
            name: "Computational_Psychiatry",
            libraryID: 1,
          },
        ],
        selectedTagContexts: [
          {
            name: "Drift",
            normalizedName: "drift",
            libraryID: 1,
          },
        ],
      },
    });

    for await (const _event of stream.events) {
      // Drain the provider stream so the runtime reaches its final state.
    }

    expect(seenPrompt).toContain(
      "Selected Zotero collection scope for this turn:",
    );
    expect(seenPrompt).toContain("Computational_Psychiatry");
    expect(seenPrompt).toContain("collectionId=42");
    expect(seenPrompt).toContain("libraryID=1");
    expect(seenPrompt).toContain('"this folder"');
    expect(seenPrompt).toContain("library_search");
    expect(seenPrompt).toContain("library_retrieve");
    expect(seenPrompt).toContain("Selected Zotero tag scope for this turn:");
    expect(seenPrompt).toContain("Drift");
    expect(seenPrompt).toContain("normalizedName=drift");
  });

  it("passes exact current-turn PDF paths and enforces path-scoped Read access", async () => {
    const firstPdf = await createPdfFile("paper a.pdf");
    const secondPdf = await createPdfFile("paper\nβ\u2028.pdf");
    let seenPrompt = "";
    let seenOptions: Record<string, unknown> = {};
    const runtime = new ClaudeAgentSdkRuntimeClient({
      additionalDirectories: ["/legacy-root"],
      queryImpl(args) {
        seenPrompt = typeof args.prompt === "string" ? args.prompt : "";
        seenOptions = args.options;
        return makeStream([
          { type: "system", session_id: "session-pdf", subtype: "init" },
          {
            type: "result",
            session_id: "session-pdf",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-pdf",
      userMessage: "compare them",
      runtimeRequest: {
        selectedPaperContexts: [
          {
            itemId: 10,
            contextItemId: 20,
            title: "Legacy duplicate",
            contentSourceMode: "pdf",
          },
        ],
        localDocuments: [
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:10:20",
            itemId: 10,
            contextItemId: 20,
            title: "Paper A",
            name: "paper a.pdf",
            mimeType: "application/pdf",
            absolutePath: firstPdf,
          },
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:11:21",
            itemId: 11,
            contextItemId: 21,
            title: "Paper B",
            name: "paper β.pdf",
            mimeType: "application/pdf",
            absolutePath: secondPdf,
          },
        ],
      },
    });
    for await (const _event of stream.events) {
      // Drain.
    }

    expect(seenPrompt).toContain("zotero-pdf:10:20");
    expect(seenPrompt).toContain(`"absolutePath":${stringifyJson(firstPdf)}`);
    expect(seenPrompt).toContain("zotero-pdf:11:21");
    expect(seenPrompt).toContain(`"absolutePath":${stringifyJson(secondPdf)}`);
    expect(seenPrompt).not.toContain(`"absolutePath":"${secondPdf}"`);
    expect(seenPrompt).toContain("\\u2028");
    expect(seenPrompt).toContain("Do not substitute sibling attachments");
    expect(seenPrompt.trim()).toMatch(
      /Raw PDF transport policy[\s\S]*instead of falling back\.$/,
    );
    expect(seenOptions.additionalDirectories).toEqual([
      dirname(firstPdf),
      dirname(secondPdf),
    ]);
    expect(seenOptions.allowedTools).toBeUndefined();
    const hooks = seenOptions.hooks as {
      PreToolUse?: Array<{
        matcher?: string;
        hooks?: Array<
          (
            input: unknown,
            toolUseId: string | undefined,
            options: unknown,
          ) => Promise<unknown>
        >;
      }>;
    };
    const readMatcher = hooks.PreToolUse?.[0];
    const readHook = readMatcher?.hooks?.[0];
    expect(readMatcher?.matcher).toBe("Read");
    expect(readHook).toBeTypeOf("function");
    await expect(
      readHook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: firstPdf },
          tool_use_id: "read-selected",
        },
        "read-selected",
        {},
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    await expect(
      readHook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: join(dirname(firstPdf), "sibling.pdf") },
          tool_use_id: "read-sibling",
        },
        "read-sibling",
        {},
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(seenOptions.persistSession).toBe(false);
    expect(seenOptions.resume).toBeUndefined();
    expect(seenOptions.continue).toBe(false);
    expect(stream.providerSessionId).toBeUndefined();
  });

  it("keeps an explicitly invoked skill on a PDF turn", async () => {
    const pdfPath = await createPdfFile();
    let seenPrompt = "";
    let seenOptions: Record<string, unknown> = {};
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenPrompt = typeof args.prompt === "string" ? args.prompt : "";
        seenOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-skill",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-pdf-skill",
      userMessage: "/my-pdf-skill answer with my format",
      allowedTools: ["Read", "Skill"],
      runtimeRequest: {
        localDocuments: [
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:10:20",
            itemId: 10,
            contextItemId: 20,
            title: "Paper",
            name: "paper.pdf",
            mimeType: "application/pdf",
            absolutePath: pdfPath,
          },
        ],
      },
    });
    for await (const _event of stream.events) void _event;

    expect(seenPrompt).toContain("/my-pdf-skill answer with my format");
    expect(seenPrompt).toContain(pdfPath);
    expect(seenOptions.allowedTools).toEqual(["Skill"]);
    expect(seenOptions.settingSources).toEqual(["user", "project", "local"]);
  });

  it("does not carry ephemeral PDF usage into auto-compaction", async () => {
    const pdfPath = await createPdfFile();
    const seenPrompts: string[] = [];
    let queryCount = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCount += 1;
        seenPrompts.push(
          typeof args.prompt === "string" ? args.prompt : "[stream]",
        );
        if (queryCount === 1) {
          return makeStream([
            {
              type: "assistant",
              session_id: "ephemeral-pdf-session",
              message: {
                content: [{ type: "text", text: "summary" }],
                usage: { input_tokens: 90, output_tokens: 1 },
              },
            },
            {
              type: "result",
              session_id: "ephemeral-pdf-session",
              result: "summary",
              is_error: false,
              modelUsage: { sonnet: { contextWindow: 100 } },
            },
          ]);
        }
        return makeStream([
          {
            type: "result",
            session_id: "persistent-session",
            result: "follow-up answer",
            is_error: false,
          },
        ]);
      },
    });

    const pdfTurn = await runtime.startTurn({
      conversationKey: "conv-pdf-usage",
      userMessage: "read it",
      metadata: {
        claudeAutoCompactEligible: true,
        claudeAutoCompactThresholdPercent: 80,
      },
      runtimeRequest: {
        localDocuments: [
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:10:20",
            itemId: 10,
            contextItemId: 20,
            title: "Paper",
            name: "paper.pdf",
            mimeType: "application/pdf",
            absolutePath: pdfPath,
          },
        ],
      },
    });
    for await (const _event of pdfTurn.events) void _event;

    const followUp = await runtime.startTurn({
      conversationKey: "conv-pdf-usage",
      userMessage: "keep this follow-up",
      metadata: {
        claudeAutoCompactEligible: true,
        claudeAutoCompactThresholdPercent: 80,
      },
    });
    for await (const _event of followUp.events) void _event;

    expect(seenPrompts[1]).toBe("keep this follow-up");
  });

  it("rejects the whole malformed local PDF batch before SDK query", async () => {
    let queryCalls = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        queryCalls += 1;
        return makeStream([]);
      },
    });

    await expect(
      runtime.startTurn({
        conversationKey: "conv-invalid-pdf",
        userMessage: "read it",
        runtimeRequest: {
          localDocuments: [
            {
              kind: "local_pdf",
              sourceKey: "zotero-pdf:10:999",
              itemId: 10,
              contextItemId: 20,
              title: "Wrong identity",
              name: "paper.pdf",
              mimeType: "application/pdf",
              absolutePath: "/papers/paper.pdf",
            },
          ],
        },
      }),
    ).rejects.toThrow("Invalid local PDF resource batch");
    expect(queryCalls).toBe(0);
  });

  it("rejects an invalid file atomically before SDK query", async () => {
    const validPdf = await createPdfFile("valid.pdf");
    const invalidPdf = await createPdfFile("invalid.pdf", "not a PDF");
    let queryCalls = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        queryCalls += 1;
        return makeStream([]);
      },
    });

    await expect(
      runtime.startTurn({
        conversationKey: "conv-invalid-file",
        userMessage: "compare",
        runtimeRequest: {
          localDocuments: [
            {
              kind: "local_pdf",
              sourceKey: "zotero-pdf:10:20",
              itemId: 10,
              contextItemId: 20,
              title: "Valid",
              name: "valid.pdf",
              mimeType: "application/pdf",
              absolutePath: validPdf,
            },
            {
              kind: "local_pdf",
              sourceKey: "zotero-pdf:11:21",
              itemId: 11,
              contextItemId: 21,
              title: "Invalid",
              name: "invalid.pdf",
              mimeType: "application/pdf",
              absolutePath: invalidPdf,
            },
          ],
        },
      }),
    ).rejects.toThrow("zotero-pdf:11:21");
    expect(queryCalls).toBe(0);
  });

  it("does not request live context usage after normal final results", async () => {
    let contextUsageCalls = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              session_id: "session-final",
              subtype: "init",
            };
            yield {
              type: "result",
              session_id: "session-final",
              result: "done",
              is_error: false,
            };
          },
          async getContextUsage() {
            contextUsageCalls += 1;
            throw new Error("getContextUsage should not be called after final");
          },
          close() {},
        } as any;
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-final-context",
      userMessage: "hello",
    });
    const types: string[] = [];
    for await (const event of stream.events) {
      types.push(event.type);
    }

    expect(types).toContain("final");
    expect(contextUsageCalls).toBe(0);
  });

  it("emits SDK canUseTool permission requests on cold streams before resolution", async () => {
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        const canUseTool = args.options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            title?: string;
            description?: string;
            displayName?: string;
            toolUseID: string;
          },
        ) => Promise<{ behavior: string }>;
        return {
          async *[Symbol.asyncIterator]() {
            const result = await canUseTool(
              "Bash",
              { command: "mkdir -p .claude/skills/example" },
              {
                signal: new AbortController().signal,
                title: "Allow Bash?",
                description: "Claude wants to create a skill directory.",
                displayName: "Bash",
                toolUseID: "tool-use-cold-permission",
              },
            );
            yield {
              type: "result",
              session_id: "session-permission",
              result: result.behavior,
              is_error: false,
            };
          },
          close() {},
        } as any;
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-permission-cold",
      userMessage: "install a skill",
    });
    const iterator = stream.events[Symbol.asyncIterator]();
    let confirmation: any;
    for (let i = 0; i < 5; i += 1) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      if (next.value.type === "confirmation_required") {
        confirmation = next.value;
        break;
      }
    }

    expect(confirmation?.payload?.requestId).toMatch(/^perm-/);
    expect(confirmation?.payload?.action?.toolName).toBe("Bash");
    expect(
      globalPermissionStore.resolve(confirmation.payload.requestId, {
        approved: true,
      }),
    ).toBe(true);

    const remainingTypes: string[] = [];
    for (;;) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      remainingTypes.push(next.value.type);
    }
    expect(remainingTypes).toContain("final");
  });

  it("omits host permission callback in yolo/bypass mode", async () => {
    let seenOptions: Record<string, unknown> = {};
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-yolo",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-yolo-permission",
      userMessage: "edit a file",
      metadata: {
        permissionMode: "yolo",
      },
    });
    for await (const _event of stream.events) {
      void _event;
    }

    expect(seenOptions.permissionMode).toBe("bypassPermissions");
    expect(seenOptions.allowDangerouslySkipPermissions).toBe(true);
    expect(seenOptions.canUseTool).toBeUndefined();
    expect(globalPermissionStore.pendingCount()).toBe(0);
  });

  it("accepts all six canonical Claude Code permission modes", async () => {
    const seenModes: unknown[] = [];
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenModes.push(args.options.permissionMode);
        return makeStream([
          {
            type: "result",
            session_id: "session-mode",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    for (const permissionMode of [
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ]) {
      const stream = await runtime.startTurn({
        conversationKey: `conv-mode-${permissionMode}`,
        userMessage: "test permissions",
        metadata: { permissionMode },
      });
      for await (const _event of stream.events) {
        void _event;
      }
    }

    expect(seenModes).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ]);
  });

  it("reports administrative availability from effective Claude settings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cc-l4z-permissions-"));
    temporaryDirectories.add(cwd);
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd,
      queryImpl() {
        return makeStream([]);
      },
      async resolveSettingsImpl() {
        return {
          effective: {
            disableAutoMode: "disable",
            permissions: {
              defaultMode: "plan",
              disableBypassPermissionsMode: "disable",
            },
          },
        };
      },
    });

    const catalog = await runtime.listPermissionModes({
      settingSources: ["user", "project", "local"],
    });

    expect(catalog.configuredDefaultMode).toBe("plan");
    expect(catalog.modes.map((mode) => mode.id)).toEqual([
      "plan",
      "dontAsk",
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
    ]);
    expect(catalog.modes.find((mode) => mode.id === "auto")).toMatchObject({
      available: false,
    });
    expect(
      catalog.modes.find((mode) => mode.id === "bypassPermissions"),
    ).toMatchObject({ available: false });
  });

  it("ignores frontend model metadata by default", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-new",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
      metadata: { model: "gemini-3.1-pro-preview", activeItemId: 123 },
    });

    expect(seenOptions.model).toBeUndefined();
    expect(seenOptions.activeItemId).toBe(123);
  });

  it("can forward frontend model metadata when explicitly enabled", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-new",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
      metadata: { model: "gemini-3.1-pro-preview" },
    });

    expect(seenOptions.model).toBe("gemini-3.1-pro-preview");
  });

  it("forwards every non-empty model value exactly, including future aliases", async () => {
    const seenModels: unknown[] = [];
    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        seenModels.push(args.options.model);
        return makeStream([
          {
            type: "result",
            session_id: "session-model-forwarding",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    for (const model of [
      "default",
      "auto",
      "FutureProvider/Model-X",
      "Claude-Mythos-6[1m]",
    ]) {
      await runtime.startTurn({
        conversationKey: `conv-${model}`,
        userMessage: "hello",
        metadata: { model },
      });
    }

    expect(seenModels).toEqual([
      "default",
      "auto",
      "FutureProvider/Model-X",
      "Claude-Mythos-6[1m]",
    ]);
  });

  it("returns the ordered structured SDK catalog without lossy suffix normalization", async () => {
    let queryCount = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        queryCount += 1;
        return makeModelProbe([
          {
            value: "default",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Default",
            description: "Current account default",
            supportsEffort: true,
            supportedEffortLevels: ["low", "xhigh", "max"],
            supportsAdaptiveThinking: true,
            supportsFastMode: false,
            supportsAutoMode: true,
          },
          {
            value: "claude-fable-5[1m]",
            displayName: "Fable",
            description: "Future model family",
          },
          {
            value: "default",
            displayName: "Duplicate should not replace first",
            description: "Duplicate",
          },
        ]);
      },
    });

    const [first, concurrent] = await Promise.all([
      runtime.listModels({ settingSources: ["user"] }),
      runtime.listModels({ settingSources: ["user"] }),
    ]);

    expect(queryCount).toBe(1);
    expect(first).toEqual([
      {
        value: "default",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Default",
        description: "Current account default",
        supportsEffort: true,
        supportedEffortLevels: ["low", "xhigh", "max"],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        supportsAutoMode: true,
      },
      {
        value: "claude-fable-5[1m]",
        displayName: "Fable",
        description: "Future model family",
      },
    ]);
    expect(concurrent).toEqual(first);
  });

  it("bypasses both model catalog caches for an explicit refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-model-refresh-"));
    temporaryDirectories.add(directory);
    let queryCount = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["project"],
      queryImpl() {
        queryCount += 1;
        return makeModelProbe([{ value: `Catalog-${queryCount}` }]);
      },
    });

    const first = await runtime.listModels();
    const cached = await runtime.listModels();
    const refreshed = await runtime.listModels({ forceRefresh: true });

    expect(first).toEqual([{ value: "Catalog-1" }]);
    expect(cached).toEqual(first);
    expect(refreshed).toEqual([{ value: "Catalog-2" }]);
    expect(queryCount).toBe(2);
  });

  it("does not let an older model probe overwrite a forced refresh", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cc-l4z-model-refresh-race-"),
    );
    temporaryDirectories.add(directory);
    let resolveOlder!: (models: unknown[]) => void;
    let resolveForced!: (models: unknown[]) => void;
    let markOlderStarted!: () => void;
    let markForcedStarted!: () => void;
    const olderModels = new Promise<unknown[]>((resolve) => {
      resolveOlder = resolve;
    });
    const forcedModels = new Promise<unknown[]>((resolve) => {
      resolveForced = resolve;
    });
    const olderStarted = new Promise<void>((resolve) => {
      markOlderStarted = resolve;
    });
    const forcedStarted = new Promise<void>((resolve) => {
      markForcedStarted = resolve;
    });
    let queryCount = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["project"],
      queryImpl() {
        queryCount += 1;
        const probeNumber = queryCount;
        return {
          async supportedModels() {
            if (probeNumber === 1) {
              markOlderStarted();
              return olderModels;
            }
            markForcedStarted();
            return forcedModels;
          },
          async return() {
            return undefined;
          },
          close() {},
        } as any;
      },
    });

    const olderRequest = runtime.listModels();
    await olderStarted;
    const forcedRequest = runtime.listModels({ forceRefresh: true });
    await forcedStarted;
    resolveForced([{ value: "FreshModel" }]);
    expect(await forcedRequest).toEqual([{ value: "FreshModel" }]);
    resolveOlder([{ value: "StaleModel" }]);
    expect(await olderRequest).toEqual([{ value: "StaleModel" }]);

    expect(await runtime.listModels()).toEqual([{ value: "FreshModel" }]);
    expect(queryCount).toBe(2);
  });

  it("invalidates the model catalog when selected settings contents change", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cc-l4z-model-settings-identity-"),
    );
    temporaryDirectories.add(directory);
    const settingsDirectory = join(directory, ".claude");
    const settingsPath = join(settingsDirectory, "settings.json");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ model: "FirstModel" }));
    let queryCount = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["project"],
      queryImpl() {
        queryCount += 1;
        return makeModelProbe([{ value: `Catalog-${queryCount}` }]);
      },
    });

    const first = await runtime.listModels();
    await writeFile(settingsPath, JSON.stringify({ model: "SecondModel" }));
    const second = await runtime.listModels();

    expect(first).toEqual([{ value: "Catalog-1" }]);
    expect(second).toEqual([{ value: "Catalog-2" }]);
    expect(queryCount).toBe(2);
  });

  it("probes and caches model catalogs by the contained scoped cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-model-scope-"));
    temporaryDirectories.add(directory);
    const seenCwds: string[] = [];
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      queryImpl({ options }) {
        seenCwds.push(String(options.cwd));
        return makeModelProbe([{ value: `ScopedModel-${seenCwds.length}` }]);
      },
    });
    const firstScope =
      "profile-test/scopes/paper/profile-test:1:42/conversations/0042";
    const secondScope =
      "profile-test/scopes/paper/profile-test:1:43/conversations/0043";

    const first = await runtime.listModels({
      settingSources: ["project", "local"],
      runtimeCwdRelative: firstScope,
    });
    const cachedFirst = await runtime.listModels({
      settingSources: ["project", "local"],
      runtimeCwdRelative: firstScope,
    });
    const second = await runtime.listModels({
      settingSources: ["project", "local"],
      runtimeCwdRelative: secondScope,
    });
    const rejectedEscape = await runtime.listModels({
      settingSources: ["project", "local"],
      runtimeCwdRelative: "../../outside-runtime-root",
    });

    expect(seenCwds).toEqual([
      resolve(directory, firstScope),
      resolve(directory, secondScope),
      resolve(directory),
    ]);
    expect(first).toEqual([{ value: "ScopedModel-1" }]);
    expect(cachedFirst).toEqual(first);
    expect(second).toEqual([{ value: "ScopedModel-2" }]);
    expect(rejectedEscape).toEqual([{ value: "ScopedModel-3" }]);
  });

  it("bounds per-runtime scoped model caches and drops completed generations", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cc-l4z-model-cache-bound-"),
    );
    temporaryDirectories.add(directory);
    let queryCount = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      queryImpl() {
        queryCount += 1;
        return makeModelProbe([{ value: `BoundedModel-${queryCount}` }]);
      },
    });
    const providerKey = "bounded-scoped-cache-test";
    const scopeFor = (index: number) =>
      `profile-test/scopes/paper/profile-test:1:${index}/conversations/${index}`;

    for (let index = 0; index <= 128; index += 1) {
      await runtime.listModels({
        providerKey,
        settingSources: ["project"],
        runtimeCwdRelative: scopeFor(index),
      });
    }
    const probesBeforeRevisit = queryCount;
    await runtime.listModels({
      providerKey,
      settingSources: ["project"],
      runtimeCwdRelative: scopeFor(0),
    });

    const state = runtime as unknown as {
      modelInfoCache: Map<string, unknown>;
      modelInfoProbeGeneration: Map<string, unknown>;
    };
    expect(queryCount).toBe(probesBeforeRevisit + 1);
    expect(state.modelInfoCache.size).toBeLessThanOrEqual(128);
    expect(state.modelInfoProbeGeneration.size).toBe(0);
  });

  it("uses the scoped model catalog for turn-time effort validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-effort-scope-"));
    temporaryDirectories.add(directory);
    const runtimeCwdRelative =
      "profile-test/scopes/paper/profile-test:1:42/conversations/0042";
    const scopedCwd = resolve(directory, runtimeCwdRelative);
    const probeCwds: string[] = [];
    let turnOptions: Record<string, unknown> = {};
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") {
          const cwd = String(args.options.cwd);
          probeCwds.push(cwd);
          return makeModelProbe([
            {
              value: "ScopedModel",
              supportsEffort: true,
              supportedEffortLevels:
                cwd === scopedCwd ? ["low", "high"] : ["low", "high", "xhigh"],
            },
          ]);
        }
        turnOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-scoped-effort",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const turn = await runtime.startTurn({
      conversationKey: "conv-scoped-effort",
      userMessage: "hello",
      metadata: {
        model: "ScopedModel",
        effort: "xhigh",
        runtimeCwdRelative,
      },
    });
    for await (const _event of turn.events) {
      // Drain the turn so the query completes.
    }

    expect(probeCwds).toEqual([scopedCwd]);
    expect(turnOptions.cwd).toBe(scopedCwd);
    expect(turnOptions.effort).toBe("high");
  });

  it("keeps a successful empty SDK catalog empty despite configured fallbacks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-model-empty-"));
    temporaryDirectories.add(directory);
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        model: "configured-model",
        availableModels: ["allowed"],
      }),
    );
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["project"],
      queryImpl() {
        return makeModelProbe([]);
      },
    });

    expect(await runtime.listModels()).toEqual([]);
  });

  it("uses configured fallback models only when discovery fails and closes the probe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-model-fallback-"));
    temporaryDirectories.add(directory);
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        model: "Configured/Model[1m]",
      }),
    );
    let returnCalls = 0;
    let closeCalls = 0;
    process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL = "Mythos-Environment-Model";
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["project"],
      queryImpl() {
        return {
          async supportedModels() {
            throw new Error("catalog unavailable");
          },
          async return() {
            returnCalls += 1;
          },
          close() {
            closeCalls += 1;
          },
        } as any;
      },
    });

    const models = await runtime.listModels();
    expect(models.slice(0, 2)).toEqual([
      { value: "default" },
      { value: "Configured/Model[1m]" },
    ]);
    expect(models).toContainEqual({ value: "Mythos-Environment-Model" });
    expect(returnCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  it("bounds a wedged supportedModels() probe and falls back instead of hanging", async () => {
    // Blocker: a stale-auth CLI could leave supportedModels() pending forever,
    // pinning the /models request and every plugin UI waiting on it.
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-model-probe-"));
    let returnCalls = 0;
    let closeCalls = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      // Project scope keyed to this test's own temp dir, so the module-level
      // model cache cannot leak into neighbouring tests.
      settingSources: ["project"],
      modelProbeTimeoutMs: 20,
      modelProbeTeardownTimeoutMs: 20,
      queryImpl() {
        return {
          supportedModels() {
            // Never settles, like a wedged CLI.
            return new Promise(() => {});
          },
          async return() {
            returnCalls += 1;
            // A closed SDK query can still expose a wedged async-generator
            // return path. Teardown must not keep the catalog request open.
            return new Promise(() => {});
          },
          close() {
            closeCalls += 1;
          },
        } as any;
      },
    });

    const models = await runtime.listModels();
    // Falls through to the settings-derived catalog rather than hanging.
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    // The throwaway session is still torn down on the timeout path.
    expect(returnCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  it("uses the SDK-merged configured model allowlist when discovery fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-model-allowlist-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "cc-l4z-model-home-"));
    temporaryDirectories.add(directory);
    temporaryDirectories.add(homeDirectory);
    await mkdir(join(directory, ".claude"), { recursive: true });
    await mkdir(join(homeDirectory, ".claude"), { recursive: true });
    await writeFile(
      join(homeDirectory, ".claude", "settings.json"),
      JSON.stringify({ availableModels: ["UserModel"] }),
    );
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        model: "ExcludedConfiguredModel",
        availableModels: ["FutureModel[1m]", "Provider/Exact-Model"],
      }),
    );
    process.env.HOME = homeDirectory;
    process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL = "ExcludedEnvironmentModel";
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["user", "project"],
      queryImpl() {
        return {
          async supportedModels() {
            throw new Error("catalog unavailable");
          },
          async return() {
            return undefined;
          },
          close() {},
        } as any;
      },
    });

    expect(await runtime.listModels()).toEqual([
      { value: "default" },
      { value: "UserModel" },
      { value: "FutureModel[1m]" },
      { value: "Provider/Exact-Model" },
    ]);
  });

  it("limits failed-discovery fallback to default for an explicit empty allowlist", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cc-l4z-model-allowlist-empty-"),
    );
    temporaryDirectories.add(directory);
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        model: "ExcludedConfiguredModel",
        availableModels: [],
      }),
    );
    process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL = "ExcludedEnvironmentModel";
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["project"],
      queryImpl() {
        return {
          async supportedModels() {
            throw new Error("catalog unavailable");
          },
          async return() {
            return undefined;
          },
          close() {},
        } as any;
      },
    });

    expect(await runtime.listModels()).toEqual([{ value: "default" }]);
  });

  it("uses the SDK effective settings so managed model policy remains authoritative", async () => {
    process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL = "ExcludedEnvironmentModel";
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        return {
          async supportedModels() {
            throw new Error("catalog unavailable");
          },
          async return() {
            return undefined;
          },
          close() {},
        } as any;
      },
      async resolveSettingsImpl() {
        return {
          effective: {
            model: "ExcludedConfiguredModel",
            availableModels: ["ManagedModel"],
          },
        };
      },
    });

    expect(await runtime.listModels()).toEqual([
      { value: "default" },
      { value: "ManagedModel" },
    ]);
  });

  it("includes cc-switch model overrides from SDK-merged settings when discovery fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-l4z-model-cc-switch-"));
    temporaryDirectories.add(directory);
    const runtime = new ClaudeAgentSdkRuntimeClient({
      cwd: directory,
      settingSources: ["user"],
      queryImpl() {
        return {
          async supportedModels() {
            throw new Error("catalog unavailable");
          },
          async return() {
            return undefined;
          },
          close() {},
        } as any;
      },
      async resolveSettingsImpl() {
        return {
          effective: {
            env: {
              ANTHROPIC_MODEL: "CCSwitch/Exact-Model[1m]",
              ANTHROPIC_DEFAULT_FABLE_MODEL: "Fable-X",
            },
          },
        };
      },
    });

    expect((await runtime.listModels()).slice(0, 3)).toEqual([
      { value: "default" },
      { value: "CCSwitch/Exact-Model[1m]" },
      { value: "Fable-X" },
    ]);
  });

  it("fails closed to default when both discovery and settings resolution fail", async () => {
    process.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL = "ExcludedEnvironmentModel";
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        return {
          async supportedModels() {
            throw new Error("catalog unavailable");
          },
          async return() {
            return undefined;
          },
          close() {},
        } as any;
      },
      async resolveSettingsImpl() {
        throw new Error("settings unavailable");
      },
    });

    expect(await runtime.listModels()).toEqual([{ value: "default" }]);
  });

  it("falls back unsupported xhigh effort when SDK capabilities are explicit", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") {
          return makeModelProbe([
            {
              value: "haiku",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high"],
            },
          ]);
        }
        seenOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-new",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    await runtime.startTurn({
      conversationKey: "conv-effort",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" },
    });

    expect(seenOptions.effort).toBe("high");
    expect(String(seenOptions.effortFallbackNotice)).toBe(
      "XHigh is unavailable for this model. Using High.",
    );
  });

  it("retries unknown xhigh effort with high when SDK init fails early", async () => {
    process.env.HOME = "/tmp/cc-l4z-effort-retry";
    const seenEfforts: unknown[] = [];
    const seenStatus: string[] = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") return makeModelProbe([]);
        seenEfforts.push(args.options.effort);
        if (args.options.effort === "xhigh") {
          return makeFailingStream(new Error("unsupported effort"));
        }
        return makeStream([
          { type: "system", session_id: "session-new", subtype: "init" },
          {
            type: "result",
            session_id: "session-new",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-effort-retry",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" },
    });

    const events = [];
    for await (const event of stream.events) {
      events.push(event.type);
      if (event.type === "status" && typeof event.payload.text === "string") {
        seenStatus.push(event.payload.text);
      }
    }

    expect(seenEfforts).toEqual(["xhigh", "high"]);
    expect(events).toContain("final");
    expect(seenStatus.some((text) => text.includes("Retrying with High"))).toBe(
      true,
    );
  });

  it("remembers the last good effort after an early retry", async () => {
    process.env.HOME = "/tmp/cc-l4z-effort-cache";
    const seenEfforts: unknown[] = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") return makeModelProbe([]);
        seenEfforts.push(args.options.effort);
        if (seenEfforts.length === 1 && args.options.effort === "xhigh") {
          return makeFailingStream(new Error("unsupported effort"));
        }
        return makeStream([
          {
            type: "system",
            session_id: `session-${seenEfforts.length}`,
            subtype: "init",
          },
          {
            type: "result",
            session_id: `session-${seenEfforts.length}`,
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    for (const conversationKey of [
      "conv-effort-cache-a",
      "conv-effort-cache-b",
    ]) {
      const stream = await runtime.startTurn({
        conversationKey,
        userMessage: "hello",
        metadata: { model: "haiku", effort: "xhigh" },
      });
      for await (const _event of stream.events) {
        void _event;
      }
    }

    const cache = (runtime as any).effortSuccessCache as Map<
      string,
      { updatedAt: number }
    >;
    for (const record of cache.values()) {
      record.updatedAt = Date.now() - 10 * 60_000;
    }

    const stream = await runtime.startTurn({
      conversationKey: "conv-effort-cache-c",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" },
    });
    for await (const _event of stream.events) {
      void _event;
    }

    expect(seenEfforts).toEqual(["xhigh", "high", "high", "xhigh"]);
  });

  it("forwards appendSystemPrompt option to sdk query options", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      appendSystemPrompt: "Use evidence-first reading style.",
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-new",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
    });

    expect(seenOptions.appendSystemPrompt).toBe(
      "Use evidence-first reading style.",
    );
  });

  it("falls back to USERPROFILE for user settings path", async () => {
    let seenOptions: Record<string, unknown> = {};

    delete process.env.HOME;
    process.env.USERPROFILE = "/tmp/windows-home";

    const runtime = new ClaudeAgentSdkRuntimeClient({
      settingSources: ["user"],
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          {
            type: "result",
            session_id: "session-new",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
    });

    expect(String(seenOptions.appendSystemPrompt)).toContain(
      "/tmp/windows-home/.claude/settings.json",
    );
  });

  it("includes paper, attachment, and note context in prompt text", async () => {
    let seenPrompt: unknown;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenPrompt = args.prompt;
        return makeStream([
          {
            type: "result",
            session_id: "session-new",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    await runtime.startTurn({
      conversationKey: "conv-light",
      userMessage: "hello",
      runtimeRequest: {
        selectedPaperContexts: [
          { title: "Paper A", contextItemId: 1, contextFilePath: "/tmp/a.md" },
        ],
        fullTextPaperContexts: [
          { title: "Paper B", contextItemId: 2, contextFilePath: "/tmp/b.md" },
        ],
        pinnedPaperContexts: [
          { title: "Paper C", contextItemId: 3, contextFilePath: "/tmp/c.md" },
        ],
        attachments: [
          {
            name: "notes.txt",
            storedPath: "/tmp/notes.txt",
            mimeType: "text/plain",
          },
        ],
        activeNoteContext: { title: "Note", noteText: "content" },
      } as Record<string, unknown>,
    });

    expect(typeof seenPrompt).toBe("string");
    expect(String(seenPrompt)).toContain("Selected papers for this turn:");
    expect(String(seenPrompt)).toContain("Paper A");
    expect(String(seenPrompt)).toContain(
      "Papers marked for full-text reading on this turn:",
    );
    expect(String(seenPrompt)).toContain("Paper B");
    expect(String(seenPrompt)).toContain("Pinned papers:");
    expect(String(seenPrompt)).toContain("Paper C");
    expect(String(seenPrompt)).toContain("Attachments:");
    expect(String(seenPrompt)).toContain("notes.txt");
    expect(String(seenPrompt)).toContain("Active note context:");
    expect(String(seenPrompt)).toContain("Title: Note");
  });

  it("injects local Zotero history only for resume fallback turns", async () => {
    let fallbackPrompt: unknown;
    let normalPrompt: unknown;

    const fallbackRuntime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        fallbackPrompt = args.prompt;
        return makeStream([
          {
            type: "result",
            session_id: "session-fallback",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });
    await fallbackRuntime.startTurn({
      conversationKey: "conv-fallback-history",
      userMessage: "continue",
      metadata: { claudeResumeFallbackHistory: true },
      runtimeRequest: {
        history: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
      } as Record<string, unknown>,
    });

    const normalRuntime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        normalPrompt = args.prompt;
        return makeStream([
          {
            type: "result",
            session_id: "session-normal",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });
    await normalRuntime.startTurn({
      conversationKey: "conv-normal-history",
      userMessage: "continue",
      runtimeRequest: {
        history: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
      } as Record<string, unknown>,
    });

    expect(String(fallbackPrompt)).toContain(
      "Local Zotero conversation history",
    );
    expect(String(fallbackPrompt)).toContain("old answer");
    expect(String(normalPrompt)).not.toContain(
      "Local Zotero conversation history",
    );
    expect(String(normalPrompt)).not.toContain("old answer");
  });

  it("preserves history-gap continuity across compact and skill commands", async () => {
    const pdfPath = await createPdfFile();
    const seenPrompts: string[] = [];
    let queryCalls = 0;
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCalls += 1;
        seenPrompts.push(
          typeof args.prompt === "string" ? args.prompt : "[stream]",
        );
        return makeStream([
          {
            type: "result",
            session_id: `session-${queryCalls}`,
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });
    const sessionMapper = new InMemorySessionMapper();
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtime,
      sessionMapper,
    });

    await adapter.runTurn({
      conversationKey: "conv-gap-command",
      userMessage: "read the selected PDF",
      runtimeRequest: {
        history: [{ role: "user", content: "earlier question" }],
        localDocuments: [
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:10:20",
            itemId: 10,
            contextItemId: 20,
            title: "Paper",
            name: "paper.pdf",
            mimeType: "application/pdf",
            absolutePath: pdfPath,
          },
        ],
      },
    });
    expect(
      await sessionMapper.get("conv-gap-command::local-pdf-history-gap"),
    ).toBe("1");

    const history = [
      { role: "user", content: "read the selected PDF" },
      { role: "assistant", content: "PDF summary" },
    ];
    await expect(
      adapter.runTurn({
        conversationKey: "conv-gap-command",
        userMessage: "/compact",
        runtimeRequest: { history },
      }),
    ).rejects.toThrow(
      "Cannot compact while Claude continuity is being rebuilt",
    );
    expect(queryCalls).toBe(1);
    expect(
      await sessionMapper.get("conv-gap-command::local-pdf-history-gap"),
    ).toBe("1");

    await adapter.runTurn({
      conversationKey: "conv-gap-command",
      userMessage: "/my-skill compare the result",
      runtimeRequest: { history },
    });

    expect(seenPrompts[1]).toMatch(/^\/my-skill compare the result/);
    expect(seenPrompts[1]).toContain("Local Zotero conversation history");
    expect(seenPrompts[1]).toContain("PDF summary");
    expect(
      await sessionMapper.get("conv-gap-command::local-pdf-history-gap"),
    ).toBeUndefined();
  });

  it("adapter updates session mapper from streamed sessionId", async () => {
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        return makeStream([
          { type: "system", session_id: "sess-live", subtype: "init" },
          {
            type: "result",
            session_id: "sess-live",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const sessionMapper = new InMemorySessionMapper();
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtime,
      sessionMapper,
    });

    const outcome = await adapter.runTurn({
      conversationKey: "conv-session",
      userMessage: "ping",
    });

    expect(outcome.providerSessionId).toBe("sess-live");
    expect(await sessionMapper.get("conv-session")).toBe("sess-live");
  });

  it("passes Claude 1m context model aliases through to SDK", async () => {
    const seenModels: Array<unknown> = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        seenModels.push(options.model);
        return makeStream([
          { type: "system", session_id: "sess-1m", subtype: "init" },
          {
            type: "result",
            session_id: "sess-1m",
            result: "ok",
            is_error: false,
          },
        ]);
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-1m-model",
      userMessage: "hello",
      metadata: { model: "sonnet[1m]" },
    });
    for await (const _event of stream.events) {
      void _event;
    }

    expect(seenModels).toEqual(["sonnet[1m]"]);
  });

  it("keeps hot runtime when resolved model changes after cache warmup", async () => {
    setCachedModels(["user", "project"], []);
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      settingSources: ["user", "project"],
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        const prompt = args.prompt;
        if (typeof prompt !== "string") {
          queryCount += 1;
          seenResumes.push(options.resume);
        }
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt as AsyncIterable<unknown>) {
              turnIndex += 1;
              yield { type: "system", session_id: "sess-hot", subtype: "init" };
              yield {
                type: "result",
                session_id: "sess-hot",
                result: `ok-${turnIndex}`,
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-hot", userMessage: "" },
      "mount-1",
    );
    await runtime.warmHotRuntime?.({
      conversationKey: "conv-hot",
      userMessage: "",
      metadata: { model: "sonnet" },
    });

    const first = await runtime.startTurn({
      conversationKey: "conv-hot",
      userMessage: "hello",
      metadata: { model: "sonnet" },
    });
    for await (const _event of first.events) {
      void _event;
    }

    setCachedModels(["user", "project"], [{ value: "claude-sonnet-4-6" }]);

    const second = await runtime.startTurn({
      conversationKey: "conv-hot",
      userMessage: "again",
      metadata: { model: "sonnet" },
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(1);
    expect(seenResumes).toEqual([undefined]);
  });

  it("rebuilds retained hot runtime on model and permission changes while resuming the same session", async () => {
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    const seenPermissionModes: Array<unknown> = [];
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        const prompt = args.prompt;
        if (typeof prompt !== "string") {
          queryCount += 1;
          seenResumes.push(options.resume);
          seenPermissionModes.push(options.permissionMode);
        }
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt as AsyncIterable<unknown>) {
              turnIndex += 1;
              yield {
                type: "system",
                session_id: "sess-hot-rebuild",
                subtype: "init",
              };
              yield {
                type: "result",
                session_id: "sess-hot-rebuild",
                result: `ok-${turnIndex}`,
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-hot-rebuild", userMessage: "" },
      "mount-1",
    );
    const first = await runtime.startTurn({
      conversationKey: "conv-hot-rebuild",
      userMessage: "hello",
      metadata: { model: "sonnet", permissionMode: "default" },
    });
    for await (const _event of first.events) {
      void _event;
    }

    const second = await runtime.startTurn({
      conversationKey: "conv-hot-rebuild",
      userMessage: "again",
      metadata: { model: "opus", permissionMode: "default" },
    });
    for await (const _event of second.events) {
      void _event;
    }

    const third = await runtime.startTurn({
      conversationKey: "conv-hot-rebuild",
      userMessage: "one more time",
      metadata: { model: "opus", permissionMode: "plan" },
    });
    for await (const _event of third.events) {
      void _event;
    }

    expect(queryCount).toBe(3);
    expect(seenResumes).toEqual([
      undefined,
      "sess-hot-rebuild",
      "sess-hot-rebuild",
    ]);
    expect(seenPermissionModes).toEqual(["default", "default", "plan"]);
  });

  it("uses a fresh ephemeral query for every PDF turn", async () => {
    const firstPdf = await createPdfFile("paper.pdf");
    const secondPdf = await createPdfFile("paper.pdf");
    let queryCount = 0;
    const seenDirectories: unknown[] = [];
    const seenPrompts: string[] = [];
    const seenPersistence: unknown[] = [];
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCount += 1;
        const sessionId = `sess-${queryCount}`;
        seenDirectories.push(args.options.additionalDirectories);
        seenPrompts.push(
          typeof args.prompt === "string" ? args.prompt : "[stream]",
        );
        seenPersistence.push(args.options.persistSession);
        if (typeof args.prompt === "string") {
          return makeStream([
            { type: "system", session_id: sessionId, subtype: "init" },
            {
              type: "result",
              session_id: sessionId,
              result: "ok",
              is_error: false,
            },
          ]);
        }
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              yield { type: "system", session_id: sessionId, subtype: "init" };
              yield {
                type: "result",
                session_id: sessionId,
                result: "ok",
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });
    const document = (
      itemId: number,
      contextItemId: number,
      absolutePath: string,
    ) => ({
      kind: "local_pdf",
      sourceKey: `zotero-pdf:${itemId}:${contextItemId}`,
      itemId,
      contextItemId,
      title: "Paper",
      name: "paper.pdf",
      mimeType: "application/pdf",
      absolutePath,
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-hot-pdf", userMessage: "" },
      "mount-1",
    );
    const first = await runtime.startTurn({
      conversationKey: "conv-hot-pdf",
      userMessage: "read A",
      runtimeRequest: { localDocuments: [document(10, 20, firstPdf)] },
    });
    for await (const _event of first.events) void _event;

    const second = await runtime.startTurn({
      conversationKey: "conv-hot-pdf",
      userMessage: "read B",
      runtimeRequest: { localDocuments: [document(11, 21, secondPdf)] },
    });
    for await (const _event of second.events) void _event;

    const third = await runtime.startTurn({
      conversationKey: "conv-hot-pdf",
      userMessage: "continue without a PDF",
    });
    const thirdTurnStages: string[] = [];
    for await (const event of third.events) {
      if (event.type !== "provider_event") continue;
      const payload = event.payload as Record<string, unknown>;
      const nested = payload.payload as Record<string, unknown> | undefined;
      if (
        payload.providerType === "profiling" &&
        typeof nested?.stage === "string"
      ) {
        thirdTurnStages.push(nested.stage);
      }
    }

    expect(queryCount).toBe(3);
    expect(seenDirectories).toEqual([
      [dirname(firstPdf)],
      [dirname(secondPdf)],
      undefined,
    ]);
    expect(seenPrompts[0]).toContain(firstPdf);
    expect(seenPrompts[0]).not.toContain(secondPdf);
    expect(seenPrompts[1]).toContain(secondPdf);
    expect(seenPrompts[1]).not.toContain(firstPdf);
    expect(seenPrompts[2]).not.toContain(firstPdf);
    expect(seenPrompts[2]).not.toContain(secondPdf);
    expect(seenPersistence).toEqual([false, false, undefined]);
    expect(thirdTurnStages).toContain("runtime.start_turn.hot_entry_found");
    const retainedEntry = (runtime as any).hotRuntimePool.get("conv-hot-pdf");
    expect(Array.from(retainedEntry?.mounts || [])).toEqual(["mount-1"]);
    await runtime.invalidateHotRuntime("conv-hot-pdf");
  });

  it("rebuilds retained hot runtime when MCP server config changes", async () => {
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    const seenMcpServers: Array<unknown> = [];
    let turnIndex = 0;
    const makeMcpServers = (token: string) => ({
      llm_for_zotero: {
        type: "http",
        url: "http://127.0.0.1:23119/llm-for-zotero/mcp",
        headers: {
          Authorization: "Bearer static-token",
          "X-LLM-For-Zotero-Scope": token,
        },
      },
    });

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        const prompt = args.prompt;
        if (typeof prompt !== "string") {
          queryCount += 1;
          seenResumes.push(options.resume);
          seenMcpServers.push(options.mcpServers);
        }
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt as AsyncIterable<unknown>) {
              turnIndex += 1;
              yield {
                type: "system",
                session_id: "sess-hot-mcp",
                subtype: "init",
              };
              yield {
                type: "result",
                session_id: "sess-hot-mcp",
                result: `ok-${turnIndex}`,
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-hot-mcp", userMessage: "" },
      "mount-1",
    );
    const first = await runtime.startTurn({
      conversationKey: "conv-hot-mcp",
      userMessage: "hello",
      mcpServers: makeMcpServers("scope-token-1"),
    });
    for await (const _event of first.events) {
      void _event;
    }

    const second = await runtime.startTurn({
      conversationKey: "conv-hot-mcp",
      userMessage: "again",
      mcpServers: makeMcpServers("scope-token-2"),
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(2);
    expect(seenResumes).toEqual([undefined, "sess-hot-mcp"]);
    expect(seenMcpServers).toEqual([
      makeMcpServers("scope-token-1"),
      makeMcpServers("scope-token-2"),
    ]);
  });

  it("retries retained hot runtime with high when unknown xhigh effort fails before init", async () => {
    process.env.HOME = "/tmp/cc-l4z-hot-effort-retry";
    const seenEfforts: Array<unknown> = [];
    const seenStatus: string[] = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") return makeModelProbe([]);
        const options = args.options as Record<string, unknown>;
        seenEfforts.push(options.effort);
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            if (options.effort === "xhigh") {
              throw new Error("unsupported effort");
            }
            for await (const _message of prompt) {
              yield {
                type: "system",
                session_id: "sess-hot-effort",
                subtype: "init",
              };
              yield {
                type: "result",
                session_id: "sess-hot-effort",
                result: "ok",
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-hot-effort", userMessage: "" },
      "mount-1",
    );
    const stream = await runtime.startTurn({
      conversationKey: "conv-hot-effort",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" },
    });

    const seenEvents = [];
    for await (const event of stream.events) {
      seenEvents.push(event.type);
      if (event.type === "status" && typeof event.payload.text === "string") {
        seenStatus.push(event.payload.text);
      }
    }

    expect(seenEfforts).toEqual(["xhigh", "high"]);
    expect(seenEvents).toContain("final");
    expect(seenStatus.some((text) => text.includes("Retrying with High"))).toBe(
      true,
    );
  });

  it("bypasses retained hot runtime when forceFreshSession is requested", async () => {
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCount += 1;
        const options = args.options as Record<string, unknown>;
        seenResumes.push(options.resume);
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              turnIndex += 1;
              yield {
                type: "system",
                session_id: turnIndex === 1 ? "sess-old" : "sess-fresh",
                subtype: "init",
              };
              yield {
                type: "result",
                session_id: turnIndex === 1 ? "sess-old" : "sess-fresh",
                result: `ok-${turnIndex}`,
                is_error: false,
              };
            }
          },
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-fresh-hot", userMessage: "" },
      "mount-1",
    );

    const first = await runtime.startTurn({
      conversationKey: "conv-fresh-hot",
      userMessage: "hello",
    });
    for await (const _event of first.events) {
      void _event;
    }

    const second = await runtime.startTurn({
      conversationKey: "conv-fresh-hot",
      userMessage: "fresh please",
      providerSessionId: "stale-session",
      metadata: { forceFreshSession: true },
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(2);
    expect(seenResumes).toEqual([undefined, undefined]);
  });

  it("keeps hot runtime alive after release within retention window", async () => {
    let queryCount = 0;
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCount += 1;
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              turnIndex += 1;
              yield {
                type: "system",
                session_id: "sess-retained",
                subtype: "init",
              };
              yield {
                type: "result",
                session_id: "sess-retained",
                result: `ok-${turnIndex}`,
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-retained", userMessage: "" },
      "mount-1",
    );
    const first = await runtime.startTurn({
      conversationKey: "conv-retained",
      userMessage: "hello",
    });
    for await (const _event of first.events) {
      void _event;
    }

    await runtime.releaseHotRuntime("conv-retained", "mount-1");
    await runtime.retainHotRuntime(
      { conversationKey: "conv-retained", userMessage: "" },
      "mount-2",
    );

    const second = await runtime.startTurn({
      conversationKey: "conv-retained",
      userMessage: "again",
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(1);
  });

  it("warms retained hot runtime before the first follow-up turn", async () => {
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCount += 1;
        const options = args.options as Record<string, unknown>;
        seenResumes.push(options.resume);
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              turnIndex += 1;
              yield {
                type: "system",
                session_id: "sess-warm",
                subtype: "init",
              };
              yield {
                type: "result",
                session_id: "sess-warm",
                result: `ok-${turnIndex}`,
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-warm", userMessage: "" },
      "mount-1",
    );
    await runtime.warmHotRuntime?.({
      conversationKey: "conv-warm",
      userMessage: "",
      providerSessionId: "sess-existing",
    });

    const warmedEntry = (runtime as any).hotRuntimePool.get("conv-warm");
    expect(Boolean(warmedEntry?.query)).toBe(true);
    expect(warmedEntry?.providerSessionId).toBe("sess-existing");

    const first = await runtime.startTurn({
      conversationKey: "conv-warm",
      userMessage: "hello after retain",
      providerSessionId: "sess-existing",
    });
    for await (const _event of first.events) {
      void _event;
    }

    expect(queryCount).toBe(1);
    expect(seenResumes).toEqual(["sess-existing"]);
  });

  it("emits SDK canUseTool permission requests from warmed hot runtimes", async () => {
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        const prompt = args.prompt as AsyncIterable<unknown>;
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            title?: string;
            description?: string;
            displayName?: string;
            toolUseID: string;
          },
        ) => Promise<{ behavior: string }>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              const result = await canUseTool(
                "Bash",
                { command: "mkdir -p .claude/skills/example" },
                {
                  signal: new AbortController().signal,
                  title: "Allow Bash?",
                  description: "Claude wants to create a skill directory.",
                  displayName: "Bash",
                  toolUseID: "tool-use-hot-permission",
                },
              );
              yield {
                type: "result",
                session_id: "sess-hot-permission",
                result: result.behavior,
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      },
    });

    await runtime.retainHotRuntime(
      { conversationKey: "conv-hot-permission", userMessage: "" },
      "mount-1",
    );
    await runtime.warmHotRuntime?.({
      conversationKey: "conv-hot-permission",
      userMessage: "",
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-hot-permission",
      userMessage: "install a skill",
    });
    const iterator = stream.events[Symbol.asyncIterator]();
    let confirmation: any;
    for (let i = 0; i < 6; i += 1) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      if (next.value.type === "confirmation_required") {
        confirmation = next.value;
        break;
      }
    }

    expect(confirmation?.payload?.requestId).toMatch(/^perm-/);
    expect(confirmation?.payload?.action?.toolName).toBe("Bash");
    expect(
      globalPermissionStore.resolve(confirmation.payload.requestId, {
        approved: true,
      }),
    ).toBe(true);

    const remainingTypes: string[] = [];
    for (;;) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      remainingTypes.push(next.value.type);
    }
    expect(remainingTypes).toContain("final");
  });
});
