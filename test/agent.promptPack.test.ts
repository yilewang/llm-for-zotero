import { assert } from "chai";
import {
  loadAgentPromptPack,
  resetAgentPromptPackCache,
} from "../src/modules/contextPanel/Agent/promptPack";

describe("agent promptPack", function () {
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;

  beforeEach(function () {
    resetAgentPromptPackCache();
  });

  after(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("loads prompts from files and caches them", async function () {
    let fetchCalls = 0;
    const requestedUrls: string[] = [];
    (globalThis as typeof globalThis & { ztoolkit: { getGlobal: (name: string) => unknown } })
      .ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (url: string) => {
          fetchCalls += 1;
          requestedUrls.push(url);
          if (url.includes("agent-router.txt")) {
            return {
              ok: true,
              text: async () => "router-file-prompt",
            } as Response;
          }
          if (url.includes("agent-responder.txt")) {
            return {
              ok: true,
              text: async () => "responder-file-prompt",
            } as Response;
          }
          return {
            ok: false,
            text: async () => "",
          } as Response;
        };
      },
    };

    const first = await loadAgentPromptPack();
    const second = await loadAgentPromptPack();

    assert.equal(first.routerPrompt, "router-file-prompt");
    assert.equal(first.responderPrompt, "responder-file-prompt");
    assert.equal(first.source, "file");
    assert.equal(second.routerPrompt, "router-file-prompt");
    assert.equal(fetchCalls, 2);
    assert.isTrue(
      requestedUrls.every((url) =>
        url.includes("/src/modules/contextPanel/Agent/prompts/"),
      ),
      "Prompt files should be loaded from src/modules/contextPanel/Agent/prompts",
    );
  });

  it("falls back when prompt files cannot be loaded", async function () {
    (globalThis as typeof globalThis & { ztoolkit: { getGlobal: (name: string) => unknown } })
      .ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async () => ({
          ok: false,
          text: async () => "",
        }) as Response;
      },
    };

    const result = await loadAgentPromptPack();

    assert.equal(result.source, "fallback");
    assert.include(result.routerPrompt, "router");
    assert.include(result.responderPrompt, "final responder");
  });
});
