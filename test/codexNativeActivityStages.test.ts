import { assert } from "chai";
import {
  mapCodexNativeItemToEvents,
  type CodexNativeActivityItem,
} from "../src/codexAppServer/nativeActivityStages";

/**
 * The bridge, not the panel, says what Codex's own work was.
 *
 * Codex reports web searches, image work, commands and file edits as items of
 * its own protocol. Each one has a kind the protocol already states, so the
 * mapping from that kind to a stage and a trace row belongs beside the client
 * that speaks the protocol. These tests pin the contract the panel appends
 * without re-deciding anything: one stage event and one activity row per item
 * and phase, with the category read from the shared table.
 */
function mapped(item: CodexNativeActivityItem, phase: "started" | "completed") {
  const events = mapCodexNativeItemToEvents(item, phase);
  assert.isNotNull(events, `${item.type} produced no events`);
  return events!;
}

describe("codex native activity maps to stages at the bridge", function () {
  it("maps a web search to a retrieval stage and its row", function () {
    const started = mapped(
      { id: "ws-1", type: "web_search", query: "drift" },
      "started",
    );
    assert.deepEqual(started.stage, {
      type: "agent_stage",
      stage: "retrieval",
      status: "started",
      toolName: "codex_web_search",
      toolLabel: "Web search",
    });
    assert.deepEqual(started.activity, {
      type: "codex_tool_activity",
      itemId: "ws-1",
      phase: "started",
      toolName: "codex_web_search",
      toolLabel: "Web search",
      args: { query: "drift" },
      text: 'Searching the web for "drift"',
      workCategory: "retrieval",
    });

    const completed = mapped(
      { id: "ws-1", type: "web_search", query: "drift" },
      "completed",
    );
    assert.deepEqual(completed.stage, {
      type: "agent_stage",
      stage: "retrieval",
      status: "completed",
      toolName: "codex_web_search",
      toolLabel: "Web search",
    });
    assert.equal(completed.activity?.text, 'Searched the web for "drift"');
    assert.equal(completed.activity?.ok, true);
  });

  it("reads the web action the protocol reported, not the prose", function () {
    const openPage = mapped(
      {
        id: "ws-2",
        type: "web_search",
        action: { type: "openPage", url: "https://example.org/a" },
      },
      "completed",
    );
    assert.equal(openPage.activity?.text, "Opened example.org");
    assert.deepEqual(openPage.activity?.args, { url: "https://example.org/a" });

    const findInPage = mapped(
      {
        id: "ws-3",
        type: "web_search",
        action: { type: "findInPage", pattern: "drift" },
      },
      "started",
    );
    assert.equal(findInPage.activity?.text, "Searching within page");
  });

  it("maps image generation to a generation stage and hands over the image", function () {
    const started = mapped(
      { id: "ig-1", type: "image_generation", status: "generating" },
      "started",
    );
    assert.equal(started.stage?.stage, "generation");
    assert.equal(started.stage?.status, "started");
    assert.equal(started.activity?.text, "Generating image");
    assert.isUndefined(started.generatedImage);

    const completed = mapped(
      {
        id: "ig-1",
        type: "image_generation",
        status: "completed",
        savedPath: "/tmp/images/bird.png",
      },
      "completed",
    );
    assert.equal(completed.stage?.status, "completed");
    assert.equal(completed.activity?.workCategory, "generation");
    assert.deepEqual(completed.activity?.args, {
      status: "completed",
      saved: "bird.png",
    });
    assert.deepEqual(completed.generatedImage, {
      id: "ig-1",
      label: "bird.png",
      path: "/tmp/images/bird.png",
    });
  });

  it("maps an image view to a retrieval stage", function () {
    const completed = mapped(
      { id: "iv-1", type: "image_view", path: "/tmp/figure.png" },
      "completed",
    );
    assert.equal(completed.stage?.stage, "retrieval");
    assert.equal(completed.activity?.toolName, "image_view");
    assert.deepEqual(completed.activity?.args, { path: "/tmp/figure.png" });
    assert.equal(completed.activity?.text, "Viewed image");
  });

  it("maps a command to an external-system stage carrying the command", function () {
    const started = mapped(
      { id: "cmd-1", type: "command_execution", command: "pwd", cwd: "/repo" },
      "started",
    );
    assert.equal(started.stage?.stage, "external_system");
    assert.equal(started.activity?.codeBlock, "pwd");
    assert.equal(started.activity?.text, "Running pwd");

    const failed = mapped(
      {
        id: "cmd-1",
        type: "command_execution",
        command: "pwd",
        cwd: "/repo",
        exitCode: 2,
      },
      "completed",
    );
    assert.equal(failed.activity?.text, "Command failed: pwd");
    assert.deepEqual(failed.activity?.args, { cwd: "/repo", status: "exit 2" });
    // A non-zero exit is a report the command made, not a transport failure:
    // the row stays a completed external action, as it did in the panel.
    assert.equal(failed.stage?.status, "completed");
    assert.equal(failed.activity?.ok, true);
  });

  it("fails the stage when the item itself reports an error", function () {
    const denied = mapped(
      {
        id: "cmd-2",
        type: "command_execution",
        command: "rm -rf /",
        error: "Denied by the user",
      },
      "completed",
    );
    assert.equal(denied.stage?.status, "failed");
    assert.equal(denied.activity?.ok, false);
  });

  it("maps a file change to an external-system stage", function () {
    const completed = mapped(
      {
        id: "fc-1",
        type: "file_change",
        changes: { "src/a.ts": { type: "add" } },
      },
      "completed",
    );
    assert.equal(completed.stage?.stage, "external_system");
    assert.equal(completed.activity?.toolName, "file_changes");
    assert.equal(completed.activity?.text, "Created a.ts");
    assert.deepEqual(completed.activity?.args, {
      "src/a.ts": { type: "add" },
    });
  });

  it("names the command inside Codex's login-shell wrapper", function () {
    const command = `/bin/zsh -lc 'rg -n "Fig" paper.md'`;
    const completed = mapped(
      { id: "cmd-2", type: "commandExecution", command, exitCode: 0 },
      "completed",
    );
    assert.equal(completed.activity?.text, 'Ran rg -n "Fig" paper.md');
    // The block keeps exactly what ran.
    assert.equal(completed.activity?.codeBlock, command);
  });

  it("counts the files a change touched when it touched several", function () {
    const started = mapped(
      {
        id: "fc-2",
        type: "fileChange",
        changes: [
          { path: "/repo/a.ts", kind: { type: "update" } },
          { path: "/repo/b.ts", kind: { type: "update" } },
        ],
      },
      "started",
    );
    assert.equal(started.activity?.text, "Editing 2 files");
  });

  it("returns nothing for an item that is not structured work", function () {
    assert.isNull(
      mapCodexNativeItemToEvents(
        { id: "m-1", type: "agent_message" },
        "started",
      ),
    );
    assert.isNull(
      mapCodexNativeItemToEvents({ id: "r-1", type: "reasoning" }, "completed"),
    );
  });

  it("names an item the protocol left unnamed from the caller's fallback", function () {
    const events = mapped({ type: "web_search", query: "drift" }, "started");
    assert.isString(events.activity?.itemId);
    const withFallback = mapCodexNativeItemToEvents(
      { type: "web_search", query: "drift" },
      "started",
      "codex-websearch-started-7",
    );
    assert.equal(withFallback?.activity?.itemId, "codex-websearch-started-7");
  });

  it("emits the stage the compatibility projection would synthesize", function () {
    // Task 2's projection reads `codex_tool_activity.workCategory` and the
    // phase. A bridge that emits its own stage must emit the same one, or a
    // new run and an old one would render differently.
    for (const phase of ["started", "completed"] as const) {
      const events = mapped(
        { id: "cmd-3", type: "command_execution", command: "ls" },
        phase,
      );
      assert.equal(events.stage?.stage, events.activity?.workCategory);
      assert.equal(
        events.stage?.status,
        phase === "started" ? "started" : "completed",
      );
      assert.equal(events.stage?.toolName, events.activity?.toolName);
      assert.equal(events.stage?.toolLabel, events.activity?.toolLabel);
      assert.notProperty(events.stage, "projected");
    }
  });
});
