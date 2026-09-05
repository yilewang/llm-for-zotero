import { assert } from "chai";
import {
  buildAgentInitialMessages,
  composeAgentModelInput,
  renderAgentPromptEnvelope,
} from "../src/agent/model/messageBuilder";
import type { AgentModelMessage } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("agent prompt envelope", function () {
  it("distinguishes omitted transcript history from an explicit empty override", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 701,
      mode: "agent",
      userText: "Current request",
      model: "test-model",
      history: [
        { role: "user", content: "Prior user message" },
        { role: "assistant", content: "Prior assistant message" },
      ],
    });

    const derivedHistory = await buildAgentInitialMessages(request, [], []);
    const noHistory = await buildAgentInitialMessages(
      request,
      [],
      [],
      undefined,
      { transcriptMessages: [] },
    );

    assert.include(JSON.stringify(derivedHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior assistant message");
    assert.include(JSON.stringify(noHistory), "Current request");
  });

  it("freezes the rendered turn and composes fresh ordered message values", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 702,
      mode: "agent",
      userText: "Inspect the supplied image",
      model: "test-model",
      systemPrompt: "SYSTEM_SENTINEL",
      customInstructions: "CUSTOM_SENTINEL",
      screenshots: ["data:image/png;base64,ZmFrZQ=="],
    });
    const rendered = await renderAgentPromptEnvelope(
      request,
      [],
      [],
      undefined,
      {
        contentInputs: {
          images: true,
          pdfDocuments: false,
          nativeFiles: false,
        },
      },
    );
    const transcript: AgentModelMessage[] = [
      { role: "assistant", content: "Prior answer" },
    ];
    const checkpoint: AgentModelMessage = {
      role: "user",
      content: "Agent semantic continuation checkpoint: continue safely.",
    };

    const first = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });
    request.systemPrompt = "CHANGED_SYSTEM";
    request.customInstructions = "CHANGED_CUSTOM";
    request.userText = "Changed request";
    request.screenshots![0] = "data:image/png;base64,Y2hhbmdlZA==";
    const second = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });

    assert.deepEqual(second, first);
    assert.notStrictEqual(second, first);
    for (let index = 0; index < first.length; index += 1) {
      assert.notStrictEqual(second[index], first[index]);
    }
    const turnIndex = first.length - 2;
    assert.equal(first[turnIndex - 1].role, "assistant");
    assert.equal(first[turnIndex].role, "user");
    assert.equal(first.at(-1)?.role, "user");
    assert.include(messageText(first[0]), "SYSTEM_SENTINEL");
    assert.include(messageText(first[0]), "CUSTOM_SENTINEL");
    assert.include(messageText(first[turnIndex]), "Inspect the supplied image");
    assert.equal(
      typeof first[turnIndex].content === "string"
        ? ""
        : first[turnIndex].content.find((part) => part.type === "image_url")
            ?.type,
      "image_url",
    );
    assert.include(
      messageText(first.at(-1)!),
      "Agent semantic continuation checkpoint",
    );

    if (typeof first[turnIndex].content !== "string") {
      const textPart = first[turnIndex].content.find(
        (part) => part.type === "text",
      );
      if (textPart?.type === "text") textPart.text = "Mutated composed copy";
    }
    const third = composeAgentModelInput(rendered.envelope);
    assert.include(messageText(third.at(-1)!), "Inspect the supplied image");
    assert.notInclude(messageText(third.at(-1)!), "Mutated composed copy");
  });
});
