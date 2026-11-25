import { assert } from "chai";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { GeminiNativeAgentAdapter } from "../src/agent/model/geminiNative";

describe("Gemini native Agent streaming", function () {
  it("preserves consecutive identical text and reasoning deltas", async function () {
    const event = {
      candidates: [{ content: { parts: [{ text: "ha" }] } }],
    };
    const thoughtEvent = {
      candidates: [
        { content: { parts: [{ text: "Thinking", thought: true }] } },
      ],
    };
    const thoughtFrame = `data: ${JSON.stringify(thoughtEvent)}\n\n`;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    const originalGetGlobal = ztoolkit.getGlobal;
    ztoolkit.getGlobal = ((name: string) =>
      name === "fetch"
        ? async () =>
            new Response(thoughtFrame + thoughtFrame + frame + frame, {
              headers: { "Content-Type": "text/event-stream" },
            })
        : Reflect.apply(originalGetGlobal, ztoolkit, [
            name,
          ])) as typeof originalGetGlobal;

    try {
      const deltas: string[] = [];
      const reasoning: string[] = [];
      const step = await new GeminiNativeAgentAdapter().runStep({
        request: resolveAgentRuntimeRequest({
          conversationKey: 1,
          mode: "agent",
          userText: "Say haha",
          apiBase: "https://generativelanguage.googleapis.com/v1beta",
          model: "gemini-2.5-flash",
        }),
        messages: [{ role: "user", content: "Say haha" }],
        tools: [],
        onReasoning({ details }) {
          if (details) reasoning.push(details);
        },
        onTextDelta(delta) {
          deltas.push(delta);
        },
      });

      assert.deepEqual(
        { text: step.text, deltas, reasoning },
        {
          text: "haha",
          deltas: ["ha", "ha"],
          reasoning: ["Thinking", "Thinking"],
        },
      );
    } finally {
      ztoolkit.getGlobal = originalGetGlobal;
    }
  });
});
