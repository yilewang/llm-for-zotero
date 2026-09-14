import { assert } from "chai";
import { callLLMWithTimeout } from "../src/utils/llmCallTimeout";

describe("bounded utility cancellation", function () {
  it("uses Zotero's window controller when the chrome global lacks one", async function () {
    const host = globalThis as any;
    const saved = {
      Zotero: host.Zotero,
      AbortController: host.AbortController,
    };
    try {
      host.AbortController = undefined;
      host.Zotero = {
        getMainWindow: () => ({ AbortController: saved.AbortController }),
      };
      await callLLMWithTimeout({
        prompt: "Interpret",
        timeoutMs: 50,
        llmCall: async (params) => {
          assert.exists(params.signal);
          return { text: "{}", completion: { status: "complete" } };
        },
      });
    } finally {
      Object.assign(host, saved);
    }
  });
  it("ends immediately on parent cancellation even if the transport ignores its signal", async function () {
    const controller = new AbortController();
    const call = callLLMWithTimeout({
      prompt: "Interpret",
      timeoutMs: 30,
      parentSignal: controller.signal,
      llmCall: () => new Promise(() => {}),
    });
    controller.abort();
    try {
      await call;
      assert.fail("Expected cancellation");
    } catch (error) {
      assert.equal((error as Error).name, "AbortError");
    }
  });
});
