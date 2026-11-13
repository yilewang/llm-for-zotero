import { describe, expect, it } from "vitest";

import { mapToLlm4ZoteroEvent } from "../src/event-mapper/map-to-llm4zotero-event.js";

describe("mapToLlm4ZoteroEvent", () => {
  it("preserves reasoning events", () => {
    const mapped = mapToLlm4ZoteroEvent({
      type: "reasoning",
      ts: 123,
      payload: {
        round: 1,
        details: "Reasoning chunk",
      },
    });

    expect(mapped).toEqual({
      type: "reasoning",
      round: 1,
      details: "Reasoning chunk",
      summary: undefined,
    });
  });

  it("passes a step snapshot through with its runtime", () => {
    const mapped = mapToLlm4ZoteroEvent({
      type: "codex_progress",
      ts: 123,
      payload: {
        itemId: "codex-plan-checklist",
        text: "• Screen",
        status: "running",
        steps: [{ content: "Screen", status: "in_progress" }],
        runtime: "claude",
      },
    });

    expect(mapped).toEqual({
      type: "codex_progress",
      itemId: "codex-plan-checklist",
      text: "• Screen",
      status: "running",
      steps: [{ content: "Screen", status: "in_progress" }],
      runtime: "claude",
    });
  });
});
