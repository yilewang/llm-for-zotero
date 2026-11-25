import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * Gemini streams a reply in fragments, each carrying only what is new. A
 * fragment that repeats the text so far ("ha" then "ha") is still new text.
 */
describe("workflow: Gemini native agent streaming", function () {
  this.timeout(30000);

  it("preserves consecutive identical text and reasoning deltas", async function () {
    const apiBase = "https://generativelanguage.googleapis.com/v1beta";
    const frame = (part: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [part] } }],
      })}\n\n`;
    const thought = frame({ text: "Thinking", thought: true });
    const reply = frame({ text: "ha" });
    const frames = [thought, thought, reply, reply].map((text) =>
      new TextEncoder().encode(text),
    );

    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const originalGetGlobal = toolkit.getGlobal;
    toolkit.getGlobal = function (name: string) {
      if (name !== "fetch") return originalGetGlobal.call(this, name);
      return async (url: string) => {
        if (!String(url).startsWith(apiBase))
          throw new Error(
            "Unexpected network destination in isolated Gemini workflow",
          );
        let next = 0;
        return {
          ok: true,
          status: 200,
          statusText: "",
          headers: { get: () => "text/event-stream" },
          body: {
            getReader: () => ({
              read: async () =>
                next < frames.length
                  ? { value: frames[next++], done: false }
                  : { done: true },
              releaseLock: () => undefined,
              cancel: async () => undefined,
            }),
          },
        };
      };
    };

    try {
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const step = await api.streamAgentModelStep({
        conversationKey: -58300583,
        apiBase,
        apiKey: "workflow-dummy-key",
        model: "gemini-2.5-flash",
        providerProtocol: "gemini_native",
      });

      assert.deepEqual(step, {
        text: "haha",
        textDeltas: ["ha", "ha"],
        reasoning: ["Thinking", "Thinking"],
      });
    } finally {
      toolkit.getGlobal = originalGetGlobal;
    }
  });
});
