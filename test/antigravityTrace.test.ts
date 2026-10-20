import { assert } from "chai";
import { buildAgentTraceDisplayItems } from "../src/modules/contextPanel/agentTrace/render";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import { toAntigravityTraceStep } from "../src/modules/contextPanel/antigravityTrace";
import type { Message } from "../src/modules/contextPanel/types";

type TraceItem = ReturnType<
  typeof buildAgentTraceDisplayItems
>["items"][number];

function rowTexts(items: readonly TraceItem[]): string[] {
  const texts: string[] = [];
  for (const item of items) {
    if (item.type === "stage") {
      texts.push(item.label, ...rowTexts(item.children as TraceItem[]));
    } else if (item.type === "action") {
      texts.push(item.row.text);
    }
  }
  return texts;
}

describe("Antigravity activity trace", function () {
  it("shows each agy tool step as one row, from start to finish", function () {
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Antigravity",
    };
    const trace = createCodexNativeActivityTraceControllerForTests(
      message,
      () => undefined,
    );
    const step = {
      stepIndex: 3,
      toolName: "view_file",
      summary: "Reading paper.md",
    };
    trace.appendRuntimeToolStep(
      toAntigravityTraceStep({ ...step, phase: "started", failed: false }),
    );
    trace.appendRuntimeToolStep(
      toAntigravityTraceStep({ ...step, phase: "completed", failed: false }),
    );
    trace.appendRuntimeToolStep(
      toAntigravityTraceStep({
        stepIndex: 5,
        toolName: "run_command",
        phase: "completed",
        failed: true,
      }),
    );
    message.text = "Answer";
    trace.finish(message.text);

    const events = message.pendingAgentTraceEvents || [];
    const tools = events.filter(
      (entry) => entry.payload.type === "codex_tool_activity",
    );
    assert.lengthOf(tools, 2, "a step's start and finish share one row");
    const [read, command] = tools.map((entry) => entry.payload);
    assert.deepInclude(read, {
      itemId: "agy-step-3",
      phase: "completed",
      toolName: "view_file",
      text: "Reading paper.md",
      ok: true,
    });
    assert.deepInclude(command, { itemId: "agy-step-5", ok: false });
    assert.equal(events.at(-1)?.payload.type, "final");

    const { items } = buildAgentTraceDisplayItems(events, null, message);
    const texts = rowTexts(items);
    assert.include(texts, "Reading paper.md");
    assert.include(texts, "run command failed");
  });
});
