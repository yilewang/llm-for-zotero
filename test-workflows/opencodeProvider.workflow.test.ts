import { assert } from "chai";
import { setModelProviderGroups } from "../src/utils/modelProviders";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: OpenCode provider request contract", function () {
  this.timeout(30000);

  it("settings Test, chat, and agent send sessions in the real Zotero host", async function () {
    const prefix = "extensions.zotero.llmforzotero.";
    const keys = [
      "modelProviderGroups",
      "modelProviderGroupsMigrationVersion",
      "lastUsedModelEntryId",
      "outputTokenAutoMigrationNoticePending",
    ];
    const previous = new Map(
      keys.map((key) => [key, Zotero.Prefs.get(prefix + key, true)]),
    );
    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const originalGetGlobal = toolkit.getGlobal;
    const requests: Array<{ url: string; session: string; userAgent: string }> =
      [];
    const apiBase = "https://opencode.ai/zen/go/v1";
    let win: Window | undefined;
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 10000;
      while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.isTrue(condition(), message);
    };
    try {
      toolkit.getGlobal = function (name: string) {
        if (name !== "fetch") return originalGetGlobal.call(this, name);
        return async (url: string, init: RequestInit) => {
          if (!String(url).startsWith(apiBase))
            throw new Error(
              "Unexpected network destination in isolated OpenCode workflow",
            );
          const headers = init.headers as Record<string, string>;
          const session = headers["x-opencode-session"] || "";
          const userAgent = headers["user-agent"] || "";
          requests.push({ url: String(url), session, userAgent });
          const ok = Boolean(session && userAgent);
          const body = ok
            ? {
                choices: [
                  {
                    message: { role: "assistant", content: "OK" },
                    finish_reason: "stop",
                  },
                ],
              }
            : { error: { type: "MissingSessionID" } };
          return {
            ok,
            status: ok ? 200 : 400,
            statusText: "",
            body: null,
            headers: { get: () => "application/json" },
            json: async () => body,
            text: async () => JSON.stringify(body),
          };
        };
      };
      setModelProviderGroups([
        {
          id: "workflow-opencode",
          authMode: "api_key",
          apiBase,
          apiKey: "workflow-dummy-key",
          presetIdOverride: "opencode_go",
          providerProtocol: "openai_chat_compat",
          models: [
            {
              id: "workflow-opencode-model",
              model: "deepseek-v4-flash",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
            },
          ],
        },
      ]);
      win = (Zotero.Utilities.Internal as any).openPreferences(
        "llmforzotero-preferences",
      );
      await waitFor(
        () =>
          Boolean(
            win?.document.querySelector(
              '[data-llm-provider-row="workflow-opencode"]',
            ),
          ),
        "OpenCode preferences render",
      );
      const row = win!.document.querySelector(
        '[data-llm-provider-row="workflow-opencode"]',
      )!;
      const button = (
        Array.from(
          row.querySelectorAll<HTMLButtonElement>("button"),
        ) as HTMLButtonElement[]
      ).find((b) => b.textContent?.trim() === "Test")!;
      assert.isOk(button, "real settings Test button exists");
      button.click();
      await waitFor(
        () => requests.length > 0 && !button.disabled,
        "settings test completes",
      );
      assert.notInclude(row.textContent!, "MissingSessionID");
      assert.isNotEmpty(requests[0].session, "settings test sent session");
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      await api.checkProviderConversationTransport({
        conversationKey: -43900439,
        apiBase,
        apiKey: "workflow-dummy-key",
        model: "deepseek-v4-flash",
        providerProtocol: "openai_chat_compat",
      });
      assert.isAtLeast(requests.length, 5);
      assert.equal(
        new Set(requests.slice(1).map((r) => r.session)).size,
        1,
        "chat, stream fallback, and agent continuations share conversation identity",
      );
      for (const sent of requests) {
        assert.match(sent.session, /^[a-f0-9]{32}$/);
        assert.match(sent.userAgent, /^llm-for-zotero\//);
      }
    } finally {
      toolkit.getGlobal = originalGetGlobal;
      if (win && !win.closed) win.close();
      for (const [key, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value, true);
      }
    }
  });
});
