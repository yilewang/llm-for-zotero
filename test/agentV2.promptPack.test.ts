import { assert } from "chai";
import {
  loadAgentV2PromptPack,
  resetAgentV2PromptPackCache,
} from "../src/modules/contextPanel/Agent/V2/promptPack";

describe("agentV2 promptPack", function () {
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;

  beforeEach(function () {
    resetAgentV2PromptPackCache();
  });

  after(function () {
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("loads prompts from files and caches them", async function () {
    let fetchCalls = 0;
    (globalThis as typeof globalThis & { ztoolkit: { getGlobal: (name: string) => unknown } })
      .ztoolkit = {
      getGlobal: (name: string) => {
        if (name !== "fetch") return undefined;
        return async (url: string) => {
          fetchCalls += 1;
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

    const first = await loadAgentV2PromptPack();
    const second = await loadAgentV2PromptPack();

    assert.equal(first.routerPrompt, "router-file-prompt");
    assert.equal(first.responderPrompt, "responder-file-prompt");
    assert.equal(first.source, "file");
    assert.equal(second.routerPrompt, "router-file-prompt");
    assert.equal(fetchCalls, 2);
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

    const result = await loadAgentV2PromptPack();

    assert.equal(result.source, "fallback");
    assert.include(result.routerPrompt, "router");
    assert.include(result.responderPrompt, "final responder");
  });
});
